import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalAction, internalQuery } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { EXTERNAL_QUEUE_PREFETCH_TIMEOUT } from '../constants';

export type GatewayEventType =
  | 'conversation.started'
  | 'conversation.invited'
  | 'conversation.message'
  | 'conversation.ended'
  | 'conversation.timeout'
  | 'agent.state_changed'
  | 'action.finished'
  | 'agent.queue_refill_requested';

export type GatewayEventPriority = 0 | 1 | 2 | 3;

type WorldDoc = Doc<'worlds'>;
type GlobalWithProcessEnv = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEnv(name: string): string {
  const value = (globalThis as GlobalWithProcessEnv).process?.env?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing env var ${name}`);
  }
  return value;
}

const EVENT_TTL_MS: Partial<Record<GatewayEventType, number>> = {
  'conversation.started': 120_000,
  'conversation.invited': 120_000,
  'conversation.message': 120_000,
  'conversation.ended': 120_000,
  'conversation.timeout': 120_000,
  'agent.state_changed': 30_000,
  'action.finished': 60_000,
  'agent.queue_refill_requested': EXTERNAL_QUEUE_PREFETCH_TIMEOUT,
};

function computeExpiresAt(eventType: GatewayEventType, now: number): number {
  const ttlMs = EVENT_TTL_MS[eventType] ?? 60_000;
  return now + ttlMs;
}

function buildIdempotencyKey(args: {
  eventType: string;
  eventAgentId: string;
  targetAgentId: string;
  worldId: string;
  eventTs: number;
}): string {
  return `${args.eventType}:${args.worldId}:${args.eventAgentId}:${args.targetAgentId}:${args.eventTs}`;
}

type ConversationDoc = WorldDoc['conversations'][number];

function findConversationById(world: WorldDoc, conversationId: string): ConversationDoc | undefined {
  return world.conversations.find(
    (conversation) => String(conversation.id) === String(conversationId),
  );
}

export const pushEventToGateway = internalAction({
  args: {
    eventType: v.string(),
    eventAgentId: v.string(),
    targetAgentId: v.string(),
    worldId: v.string(),
    payload: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
    expiresAt: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (_ctx, args) => {
    const gatewayUrl = requireEnv('GATEWAY_URL');
    const secret = requireEnv('GATEWAY_SECRET');

    const eventContext = {
      eventType: args.eventType,
      eventAgentId: args.eventAgentId,
      targetAgentId: args.targetAgentId,
      worldId: args.worldId,
      idempotencyKey: args.idempotencyKey,
    };

    let res: Response;
    try {
      res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/gateway/event`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-secret': secret,
          'x-idempotency-key': args.idempotencyKey,
        },
        body: JSON.stringify({
          eventType: args.eventType,
          eventAgentId: args.eventAgentId,
          targetAgentId: args.targetAgentId,
          worldId: args.worldId,
          payload: args.payload,
          priority: args.priority,
          expiresAt: args.expiresAt,
          // 兼容字段：便于旧网关/旧解析器读取。
          agentId: args.eventAgentId,
          eventData: args.payload,
          eventTs: Date.now(),
          idempotencyKey: args.idempotencyKey,
        } satisfies {
          eventType: string;
          eventAgentId: string;
          targetAgentId: string;
          worldId: string;
          payload: unknown;
          priority: GatewayEventPriority;
          expiresAt: number;
          agentId: string;
          eventData: unknown;
          eventTs: number;
          idempotencyKey: string;
        }),
      });
    } catch (error: unknown) {
      console.error('Gateway push network failure', {
        ...eventContext,
        error: toErrorMessage(error),
      });
      throw new Error(
        `Gateway push network failure (eventType=${args.eventType}, eventAgentId=${args.eventAgentId}, targetAgentId=${args.targetAgentId})`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Gateway push failed', {
        ...eventContext,
        status: res.status,
        statusText: res.statusText,
        responseBody: text,
      });
      throw new Error(`Failed to push event to gateway: HTTP ${res.status}`);
    }

    console.log(`[WorldEventDispatcher] 事件推送成功: eventType=${args.eventType}, eventAgentId=${args.eventAgentId}, targetAgentId=${args.targetAgentId}, gatewayUrl=${gatewayUrl}`);
    return { ok: true };
  },
});

export const listExternalControlledAgentIds = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];
    return world.agents.map((agent) => agent.id);
  },
});

export const listExternalControlledAgentIdsByConversation = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];

    const conversation = findConversationById(world, args.conversationId);
    if (!conversation) return [];

    const participantPlayerIds = conversation.participants.map((member) => member.playerId);

    return world.agents
      .filter((agent) => participantPlayerIds.includes(agent.playerId))
      .map((agent) => agent.id);
  },
});

export const listExternalControlledAgentIdsByInvitedPlayer = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
    inviterId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];

    const conversation = findConversationById(world, args.conversationId);
    if (!conversation) return [];

    // 对于 conversation.invited：只投递给“被邀请的那一方”。
    // 数据里现有字段只有 inviterId（邀请者），因此从 participants 中排除 inviterId 来定位 invitee。
    const inviteePlayerId = conversation.participants
      .map((member) => member.playerId)
      .find((participantPlayerId) => String(participantPlayerId) !== String(args.inviterId));

    if (!inviteePlayerId) return [];

    return world.agents
      .filter((agent) => String(agent.playerId) === String(inviteePlayerId))
      .map((agent) => agent.id);
  },
});

function getConversationIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const conversationId = payload.conversationId;
  return typeof conversationId === 'string' ? conversationId : null;
}

function getInviterIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const inviterId = payload.inviterId;
  return typeof inviterId === 'string' ? inviterId : null;
}

function isConversationEventType(eventType: string): boolean {
  return eventType.startsWith('conversation.');
}

export function buildConversationStartedEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  otherParticipantIds: string[],
) {
  return {
    eventType: 'conversation.started' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      otherParticipantIds,
    },
  };
}

export function buildConversationInvitedEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  inviterId: string,
  inviterName?: string,
) {
  return {
    eventType: 'conversation.invited' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      inviterId,
      inviterName,
    },
  };
}

export function buildConversationMessageEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  messageContent: string,
  speakerId: string,
) {
  return {
    eventType: 'conversation.message' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      message: {
        content: messageContent,
        speakerId,
      },
    },
  };
}

export function buildConversationEndedEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  otherParticipantId?: string,
  otherParticipantName?: string,
) {
  return {
    eventType: 'conversation.ended' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      otherParticipantId,
      otherParticipantName,
    },
  };
}

export function buildConversationTimeoutEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  reason: 'invite_timeout' | 'idle_timeout',
) {
  return {
    eventType: 'conversation.timeout' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      reason,
    },
  };
}

export function buildAgentStateChangedEvent(
  worldId: string,
  agentId: string,
  state: string,
  position: unknown,
  nearbyPlayers: unknown,
) {
  return {
    eventType: 'agent.state_changed' as const,
    agentId,
    worldId,
    payload: {
      state,
      position,
      nearbyPlayers,
    },
  };
}

export function buildActionFinishedEvent(
  worldId: string,
  agentId: string,
  actionType: string,
  success: boolean,
  resultData: unknown,
) {
  return {
    eventType: 'action.finished' as const,
    agentId,
    worldId,
    payload: {
      actionType,
      success,
      result: resultData,
    },
  };
}

export function buildAgentQueueRefillRequestedEvent(
  worldId: string,
  agentId: string,
  playerId: string,
  requestId: string,
  remaining: number,
  lastDequeuedAt: number | undefined,
  nearbyPlayers: unknown,
) {
  return {
    eventType: 'agent.queue_refill_requested' as const,
    agentId,
    worldId,
    payload: {
      type: 'agent.queue_refill_requested' as const,
      agentId,
      playerId,
      requestId,
      remaining,
      lastDequeuedAt,
      nearbyPlayers,
      reason: remaining === 0 ? ('empty' as const) : ('low_watermark' as const),
    },
  };
}

type ScheduleEventPushCtx = Pick<ActionCtx, 'scheduler' | 'runQuery'>;
type ScheduleEventPushArgs = {
  eventType: GatewayEventType;
  eventAgentId: string;
  worldId: Id<'worlds'>;
  payload: unknown;
  priority: GatewayEventPriority;
};

export async function scheduleEventPush(ctx: ScheduleEventPushCtx, args: ScheduleEventPushArgs) {
  let targetAgentIds: string[];

  if (args.eventType === 'conversation.ended') {
    targetAgentIds = [String(args.eventAgentId)];
  } else if (args.eventType === 'agent.queue_refill_requested') {
    targetAgentIds = [String(args.eventAgentId)];
  } else if (args.eventType === 'conversation.invited') {
    const conversationId = getConversationIdFromPayload(args.payload);
    const inviterId = getInviterIdFromPayload(args.payload);
    if (!conversationId || !inviterId) {
      const payloadKeys = isRecord(args.payload) ? Object.keys(args.payload).join(',') : '';
      console.warn(
        `[WorldEventDispatcher] conversation.invited 缺少必要字段, 将跳过定向投递: worldId=${args.worldId}, eventAgentId=${args.eventAgentId}, payloadKeys=${payloadKeys}`,
      );
      targetAgentIds = [];
    } else {
      targetAgentIds = await ctx.runQuery(
        internal.aiTown.worldEventDispatcher.listExternalControlledAgentIdsByInvitedPlayer,
        { worldId: args.worldId, conversationId, inviterId },
      );
    }
  } else if (isConversationEventType(args.eventType)) {
    const conversationId = getConversationIdFromPayload(args.payload);
    if (!conversationId) {
      console.warn(
        `[WorldEventDispatcher] conversation.* 缺少 conversationId, 将跳过定向投递: eventType=${args.eventType}, worldId=${args.worldId}, eventAgentId=${args.eventAgentId}`,
      );
      targetAgentIds = [];
    } else {
      targetAgentIds = await ctx.runQuery(
        internal.aiTown.worldEventDispatcher.listExternalControlledAgentIdsByConversation,
        { worldId: args.worldId, conversationId },
      );
    }
  } else {
    targetAgentIds = await ctx.runQuery(
      internal.aiTown.worldEventDispatcher.listExternalControlledAgentIds,
      { worldId: args.worldId },
    );
  }

  if (targetAgentIds.length === 0) {
    console.log(`[WorldEventDispatcher] 跳过事件推送: 无目标外控agent, 事件类型: ${args.eventType}, worldId: ${args.worldId}`);
    return;
  }

  const now = Date.now();
  const expiresAt = computeExpiresAt(args.eventType, now);

  for (const targetAgentId of targetAgentIds) {
    const idempotencyKey = buildIdempotencyKey({
      eventType: args.eventType,
      eventAgentId: String(args.eventAgentId),
      targetAgentId: String(targetAgentId),
      worldId: String(args.worldId),
      eventTs: now,
    });

    await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.pushEventToGateway, {
      eventType: args.eventType,
      eventAgentId: String(args.eventAgentId),
      targetAgentId: String(targetAgentId),
      worldId: String(args.worldId),
      payload: args.payload,
      priority: args.priority,
      expiresAt,
      idempotencyKey,
    });

    console.log(`[WorldEventDispatcher] 已调度事件推送: eventAgentId=${args.eventAgentId}, targetAgentId=${targetAgentId}, 事件类型: ${args.eventType}, worldId: ${args.worldId}`);
  }
}

export const scheduleConversationStarted = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    otherParticipantIds: v.array(v.string()),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildConversationStartedEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.otherParticipantIds,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationInvited = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    inviterId: v.string(),
    inviterName: v.optional(v.string()),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildConversationInvitedEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.inviterId,
      args.inviterName,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    messageContent: v.string(),
    speakerId: v.string(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildConversationMessageEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.messageContent,
      args.speakerId,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationEnded = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    otherParticipantId: v.optional(v.string()),
    otherParticipantName: v.optional(v.string()),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildConversationEndedEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.otherParticipantId,
      args.otherParticipantName,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationTimeout = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    reason: v.union(v.literal('invite_timeout'), v.literal('idle_timeout')),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildConversationTimeoutEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.reason,
    );

    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleAgentStateChanged = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    state: v.string(),
    position: v.any(),
    nearbyPlayers: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildAgentStateChangedEvent(
      String(args.worldId),
      String(args.agentId),
      args.state,
      args.position,
      args.nearbyPlayers,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleActionFinished = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    actionType: v.string(),
    success: v.boolean(),
    resultData: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildActionFinishedEvent(
      String(args.worldId),
      String(args.agentId),
      args.actionType,
      args.success,
      args.resultData,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleAgentQueueRefillRequested = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    playerId: v.string(),
    requestId: v.string(),
    remaining: v.number(),
    lastDequeuedAt: v.optional(v.number()),
    nearbyPlayers: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx, args) => {
    const built = buildAgentQueueRefillRequestedEvent(
      String(args.worldId),
      String(args.agentId),
      String(args.playerId),
      String(args.requestId),
      Number(args.remaining),
      typeof args.lastDequeuedAt === 'number' ? args.lastDequeuedAt : undefined,
      args.nearbyPlayers,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});
