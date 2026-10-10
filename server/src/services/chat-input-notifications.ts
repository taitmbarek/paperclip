/**
 * Outbound input-request notifications.
 *
 * When an agent raises an `ask_user_questions` or `request_confirmation`
 * interaction on ANY task — including tasks that did not start in Slack — post
 * a Slack message with interactive buttons to each opted-in endpoint's
 * notification channel.
 *
 * Deliberately does not create a `chatConversations` row: `chatPublications`
 * requires a non-null conversation, so this path posts directly with the bot
 * token and records only nullable-conversation `chatActions` rows for the
 * button callbacks.
 *
 * Self-contained (no chat-channels import) so the interaction service can use
 * it as a default without creating an import cycle.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  chatActions,
  chatEndpointResources,
  chatEndpoints,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { secretService } from "./secrets.js";
import { slackClient } from "./connectors/slack-client.js";
import { publicChatTaskUrl } from "./chat-task-url.js";
import {
  CHAT_QUESTION_ACTION_TOKEN_TTL_MS,
  createChatConfirmationActionToken,
  createChatQuestionOptionActionToken,
} from "./chat-interaction-publications.js";

type EndpointRow = typeof chatEndpoints.$inferSelect;

/** Resolve `credentials.*` refs for a chat connection. Mirrors chat-channels. */
async function resolveEndpointCredentials(
  db: Db,
  endpoint: EndpointRow,
): Promise<Record<string, string>> {
  const connection = await db
    .select({
      refs: toolConnections.credentialSecretRefs,
      config: toolConnections.config,
    })
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, endpoint.companyId),
        eq(toolConnections.id, endpoint.connectionId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!connection) return {};
  const values: Record<string, string> = {};
  const secrets = secretService(db);
  for (const ref of connection.refs) {
    const key = ref.configPath.replace(/^credentials\./, "");
    try {
      values[key] = await secrets.resolveSecretValue(
        endpoint.companyId,
        ref.secretId,
        ref.versionSelector ?? "latest",
        {
          consumerType: "tool_connection",
          consumerId: endpoint.connectionId,
          configPath: ref.configPath,
          actorType: "system",
          actorId: null,
        },
      );
    } catch {
      // Leave the key absent; a missing bot token skips this endpoint.
    }
  }
  return values;
}

/**
 * Best-effort. Never throws: a failed notification must not break task
 * creation. Returns the number of endpoints posted to.
 */
export async function notifyInputRequestEndpoints(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    interaction: IssueThreadInteraction;
  },
): Promise<number> {
  const { interaction } = input;
  if (interaction.status !== "pending") return 0;
  if (
    interaction.kind !== "ask_user_questions" &&
    interaction.kind !== "request_confirmation"
  )
    return 0;
  if (!interaction.createdByAgentId) return 0;

  let endpoints: EndpointRow[];
  try {
    endpoints = await db
      .select()
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.companyId, input.companyId),
          eq(chatEndpoints.provider, "slack"),
          eq(chatEndpoints.status, "active"),
          eq(chatEndpoints.publicationMode, "automatic"),
          eq(chatEndpoints.notifyOnInput, true),
          isNotNull(chatEndpoints.notificationResourceId),
          // Only the endpoint belonging to the agent that raised the card. A
          // company-wide broadcast would notify every agent's channel for one
          // task's input request.
          eq(chatEndpoints.assignedAgentId, interaction.createdByAgentId),
        ),
      );
  } catch {
    return 0;
  }
  if (endpoints.length === 0) return 0;

  const taskUrl =
    publicChatTaskUrl(input.issueId) ??
    `https://paperclip.ing/issues/${input.issueId}`;
  const title =
    interaction.kind === "ask_user_questions"
      ? interaction.payload.title ?? interaction.title ?? "Input needed"
      : interaction.payload.prompt;

  let posted = 0;
  for (const endpoint of endpoints) {
    try {
      const resource = await db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.id, endpoint.notificationResourceId!),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!resource || !resource.enabled) continue;

      const credentials = await resolveEndpointCredentials(db, endpoint);
      const botToken = credentials.botToken;
      if (!botToken) continue;

      const interactionId = interaction.id;
      const dedupeKey = `input-notify:${endpoint.id}:${interactionId}`;
      const existing = await db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, endpoint.companyId),
            eq(chatActions.endpointId, endpoint.id),
            sql`${chatActions.payload}->>'dedupeKey' = ${dedupeKey}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) continue;

      const expiresAt = new Date(
        Date.now() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS,
      ).toISOString();
      const blocks: Array<Record<string, unknown>> = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:warning: *${title}*\n<${taskUrl}|Open task in Paperclip>`,
          },
        },
      ];
      const actionRecords: Array<{
        actionId: string;
        kind: string;
        payload: Record<string, unknown>;
      }> = [];

      if (interaction.kind === "request_confirmation") {
        const acceptId = createChatConfirmationActionToken();
        const rejectId = createChatConfirmationActionToken();
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              action_id: acceptId,
              value: acceptId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Reject" },
              style: "danger",
              action_id: rejectId,
              value: rejectId,
            },
          ],
        });
        actionRecords.push(
          { actionId: acceptId, kind: "input_notify_decision", payload: { version: 1, interactionId, decision: "accept", expiresAt, taskUrl, dedupeKey } },
          { actionId: rejectId, kind: "input_notify_decision", payload: { version: 1, interactionId, decision: "reject", expiresAt, taskUrl, dedupeKey } },
        );
      } else {
        const question = interaction.payload.questions[0];
        const options = question?.options ?? [];
        if (options.length === 0) continue;
        const elements = options.slice(0, 5).map((option) => {
          const actionId = createChatQuestionOptionActionToken();
          actionRecords.push({
            actionId,
            kind: "input_notify_answer",
            payload: { version: 1, interactionId, questionId: question.id, optionId: option.id, expiresAt, taskUrl, dedupeKey },
          });
          return {
            type: "button",
            text: { type: "plain_text", text: option.label.slice(0, 75) },
            action_id: actionId,
            value: actionId,
          };
        });
        blocks.push({ type: "actions", elements });
      }

      await slackClient(botToken)("chat.postMessage", {
        channel: resource.providerResourceId,
        text: title,
        blocks,
      });

      await db.insert(chatActions).values(
        actionRecords.map((record) => ({
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          conversationId: null,
          kind: record.kind,
          providerActionId: record.actionId,
          payload: record.payload,
          status: "issued",
        })),
      );
      posted += 1;
    } catch {
      // Swallow: notification failure never blocks task creation.
    }
  }
  return posted;
}
