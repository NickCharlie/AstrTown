import { api, internal } from './_generated/api';
import { Id } from './_generated/dataModel';
import { ActionCtx, action, httpAction, internalMutation, mutation, query } from './_generated/server';
import { extractSessionToken, validateSession } from './auth';
import { v } from 'convex/values';
import { Descriptions } from '../data/characters';
import { insertInput } from './aiTown/insertInput';

const CREATE_NPC_TIMEOUT_MS = 30_000;
const CREATE_NPC_POLL_MS = 500;
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
const CORS_ALLOW_HEADERS = 'Authorization, Content-Type';
const CORS_MAX_AGE_SECONDS = '86400';

function buildCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': CORS_MAX_AGE_SECONDS,
    ...(origin ? { vary: 'origin' } : {}),
  };
}

function corsPreflightResponse(request: Request) {
  const headers = request.headers;
  if (
    headers.get('origin') !== null &&
    headers.get('access-control-request-method') !== null &&
    headers.get('access-control-request-headers') !== null
  ) {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(request),
    });
  }
  return new Response(null, { status: 204 });
}

function jsonResponse(body: unknown, init?: ResponseInit, request?: Request) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(request ? buildCorsHeaders(request) : {}),
      ...(init?.headers ?? {}),
    },
  });
}

function badRequest(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 400 }, request);
}

function unauthorized(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 401 }, request);
}

function forbidden(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 403 }, request);
}

function internalError(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 500 }, request);
}

function toErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e ?? fallback);
}

function generateTokenValue() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function resolveDescriptionIndex(character?: string) {
  if (!character) {
    return Math.floor(Math.random() * Descriptions.length);
  }
  const normalized = character.trim();
  if (!normalized) {
    return Math.floor(Math.random() * Descriptions.length);
  }
  const index = Descriptions.findIndex((d) => d.character === normalized);
  if (index < 0) {
    throw new Error(`character 不存在或未配置: ${normalized}`);
  }
  return index;
}

type InputStatusResult =
  | {
      kind: 'ok';
      value: unknown;
    }
  | {
      kind: 'error';
      message: string;
    }
  | null;

type NpcTraceContext = {
  source?: string;
  requestPath?: string;
  requestMethod?: string;
  userAgent?: string;
  origin?: string;
};

type NpcCreateBody = {
  name: string;
  character?: string;
};

type NpcTokenBody = {
  botTokenId: string;
};

type NpcCreateArgs = {
  sessionToken: string;
  name: string;
  character?: string;
  traceContext?: NpcTraceContext;
};

type NpcWithName = {
  id: string;
  playerId: string;
};

type ConversationParticipant = {
  playerId?: string;
  status?: {
    kind?: string;
  };
};

type ConversationSummary = {
  id?: string;
  participants?: ConversationParticipant[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseNpcCreateBody(body: unknown): NpcCreateBody | null {
  if (!isRecord(body)) {
    return null;
  }
  const { name, character } = body;
  if (typeof name !== 'string') {
    return null;
  }
  if (character !== undefined && typeof character !== 'string') {
    return null;
  }
  return {
    name,
    character,
  };
}

function parseNpcTokenBody(body: unknown): NpcTokenBody | null {
  if (!isRecord(body)) {
    return null;
  }
  const { botTokenId } = body;
  if (typeof botTokenId !== 'string') {
    return null;
  }
  return { botTokenId };
}

function normalizeTraceContext(value: unknown): NpcTraceContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    source: typeof value.source === 'string' ? value.source : undefined,
    requestPath: typeof value.requestPath === 'string' ? value.requestPath : undefined,
    requestMethod: typeof value.requestMethod === 'string' ? value.requestMethod : undefined,
    userAgent: typeof value.userAgent === 'string' ? value.userAgent : undefined,
    origin: typeof value.origin === 'string' ? value.origin : undefined,
  };
}

function isNpcWithName(value: unknown): value is NpcWithName {
  return isRecord(value) && typeof value.id === 'string' && typeof value.playerId === 'string';
}

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (!isRecord(value)) {
    return false;
  }
  const participants = value.participants;
  return participants === undefined || Array.isArray(participants);
}

async function waitForInputStatus(ctx: ActionCtx, inputId: Id<'inputs'>): Promise<InputStatusResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CREATE_NPC_TIMEOUT_MS) {
    const status = (await ctx.runQuery(api.aiTown.main.inputStatus, {
      inputId,
    })) as InputStatusResult;
    if (status !== null) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, CREATE_NPC_POLL_MS));
  }
  return null;
}

export const setNpcNameInternal = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .unique();
    if (!playerDescription) {
      throw new Error(`playerDescription 不存在: ${args.playerId}`);
    }
    await ctx.db.patch(playerDescription._id, {
      name: args.name,
    });
  },
});

export const createNpcWithToken = action({
  args: {
    sessionToken: v.string(),
    name: v.string(),
    character: v.optional(v.string()),
    traceContext: v.optional(
      v.object({
        source: v.optional(v.string()),
        requestPath: v.optional(v.string()),
        requestMethod: v.optional(v.string()),
        userAgent: v.optional(v.string()),
        origin: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{
    agentId: string;
    playerId: string;
    token: string;
    name: string;
  }> => {
    const sessionToken = args.sessionToken.trim();
    if (!sessionToken) {
      throw new Error('sessionToken 不能为空');
    }
    const npcName = args.name.trim();
    if (!npcName) {
      throw new Error('NPC 名称不能为空');
    }

    const traceContext = normalizeTraceContext(args.traceContext);

    const user = await validateSession(ctx, sessionToken);
    if (!user) {
      throw new Error('会话无效或已过期');
    }

    const worldStatus = await ctx.runQuery(api.world.defaultWorldStatus, {});
    if (!worldStatus) {
      throw new Error('当前没有默认世界');
    }
    if (worldStatus.status !== 'running') {
      throw new Error(`世界未运行（${worldStatus.status}）`);
    }

    const descriptionIndex = resolveDescriptionIndex(args.character);
    const description = Descriptions[descriptionIndex];

    console.info('[NPC_CREATE_TRACE] begin', {
      userId: String(user.userId),
      username: user.username,
      worldId: String(worldStatus.worldId),
      npcName,
      character: args.character,
      descriptionIndex,
      descriptionName: description?.name,
      traceContext,
      ts: Date.now(),
    });

    const inputId = await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: worldStatus.worldId,
      name: 'createAgent',
      args: {
        descriptionIndex,
      },
    });

    const status = await waitForInputStatus(ctx, inputId);
    if (!status) {
      console.warn('[NPC_CREATE_TRACE] timeout', {
        userId: String(user.userId),
        worldId: String(worldStatus.worldId),
        inputId: String(inputId),
        traceContext,
        ts: Date.now(),
      });
      throw new Error('创建 NPC 超时');
    }
    if (status.kind === 'error') {
      console.warn('[NPC_CREATE_TRACE] engine_error', {
        userId: String(user.userId),
        worldId: String(worldStatus.worldId),
        inputId: String(inputId),
        message: status.message,
        traceContext,
        ts: Date.now(),
      });
      throw new Error(`创建 NPC 失败: ${status.message}`);
    }

    const statusValue = status.value;
    const agentId = isRecord(statusValue) ? statusValue.agentId : undefined;
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('创建 NPC 失败: 返回值缺少 agentId');
    }

    const worldState = await ctx.runQuery(api.world.worldState, {
      worldId: worldStatus.worldId,
    });
    const world = worldState?.world;
    if (!world) {
      throw new Error('创建 NPC 失败: 世界不存在');
    }

    const agent = world.agents.find((item) => isNpcWithName(item) && item.id === agentId);
    if (!agent) {
      throw new Error('创建 NPC 失败: 未找到新建 agent');
    }

    const playerId = agent.playerId;
    if (!playerId || typeof playerId !== 'string') {
      throw new Error('创建 NPC 失败: 未找到 playerId');
    }

    await ctx.runMutation(internal.npcService.setNpcNameInternal, {
      worldId: worldStatus.worldId,
      playerId,
      name: npcName,
    });

    const tokenResult = await ctx.runMutation(api.botApi.createBotToken, {
      agentId,
      playerId,
      userId: user.userId,
      worldId: worldStatus.worldId,
      expiresAt: 0,
      description: `self-service npc for ${user.username}`,
    });

    console.info('[NPC_CREATE_TRACE] success', {
      userId: String(user.userId),
      username: user.username,
      worldId: String(worldStatus.worldId),
      inputId: String(inputId),
      agentId,
      playerId,
      npcName,
      character: args.character,
      descriptionIndex,
      descriptionName: description?.name,
      traceContext,
      ts: Date.now(),
    });

    return {
      agentId,
      playerId,
      token: tokenResult.token,
      name: npcName,
    };
  },
});

export const listMyNpcs = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const sessionToken = args.sessionToken.trim();
    if (!sessionToken) {
      throw new Error('sessionToken 不能为空');
    }

    const user = await validateSession({ db: ctx.db }, sessionToken);
    if (!user) {
      throw new Error('会话无效或已过期');
    }

    const now = Date.now();
    const docs = await ctx.db
      .query('botTokens')
      .withIndex('by_userId', (q) => q.eq('userId', user.userId))
      .order('desc')
      .collect();

    const result = await Promise.all(
      docs.map(async (doc) => {
        const playerDescription = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', doc.worldId).eq('playerId', doc.playerId))
          .unique();

        const isExpired = doc.expiresAt !== 0 && now > doc.expiresAt;
        const tokenStatus = !doc.isActive ? 'inactive' : isExpired ? 'expired' : 'active';

        return {
          botTokenId: doc._id,
          agentId: doc.agentId,
          playerId: doc.playerId,
          worldId: doc.worldId,
          createdAt: doc.createdAt,
          expiresAt: doc.expiresAt,
          lastUsedAt: doc.lastUsedAt ?? null,
          isActive: doc.isActive,
          isExpired,
          tokenStatus,
          hasToken: !!doc.token,
          name: playerDescription?.name ?? null,
          character: playerDescription?.character ?? null,
          description: doc.description ?? null,
        };
      }),
    );

    return result;
  },
});

export const resetNpcToken = mutation({
  args: {
    sessionToken: v.string(),
    botTokenId: v.id('botTokens'),
  },
  handler: async (ctx, args) => {
    const sessionToken = args.sessionToken.trim();
    if (!sessionToken) {
      throw new Error('sessionToken 不能为空');
    }

    const user = await validateSession({ db: ctx.db }, sessionToken);
    if (!user) {
      throw new Error('会话无效或已过期');
    }

    const tokenDoc = await ctx.db.get(args.botTokenId);
    if (!tokenDoc) {
      throw new Error('botToken 不存在');
    }
    if (!tokenDoc.userId || tokenDoc.userId !== user.userId) {
      throw new Error('无权操作该 botToken');
    }

    const newToken = generateTokenValue();
    await ctx.db.patch(args.botTokenId, {
      token: newToken,
      isActive: true,
      lastUsedAt: undefined,
      lastIdempotencyKey: undefined,
      lastIdempotencyResult: undefined,
    });

    return { token: newToken };
  },
});

export const interruptNpcConversation = mutation({
  args: {
    sessionToken: v.string(),
    botTokenId: v.id('botTokens'),
  },
  handler: async (ctx, args) => {
    const sessionToken = args.sessionToken.trim();
    if (!sessionToken) {
      throw new Error('sessionToken 不能为空');
    }

    const user = await validateSession({ db: ctx.db }, sessionToken);
    if (!user) {
      throw new Error('会话无效或已过期');
    }

    const tokenDoc = await ctx.db.get(args.botTokenId);
    if (!tokenDoc) {
      throw new Error('botToken 不存在');
    }
    if (!tokenDoc.userId || tokenDoc.userId !== user.userId) {
      throw new Error('无权操作该 botToken');
    }

    const world = await ctx.db.get(tokenDoc.worldId);
    if (!world) {
      throw new Error('世界不存在');
    }

    const activeConversation = world.conversations.find((conversation) => {
      if (!isConversationSummary(conversation) || !Array.isArray(conversation.participants)) {
        return false;
      }
      return conversation.participants.some(
        (member) =>
          isRecord(member) &&
          member.playerId === tokenDoc.playerId &&
          isRecord(member.status) &&
          member.status.kind === 'participating',
      );
    });

    if (!activeConversation || typeof activeConversation.id !== 'string') {
      throw new Error('该 NPC 当前不在进行中的对话中');
    }

    const inputId = await insertInput(ctx, tokenDoc.worldId, 'leaveConversation', {
      playerId: tokenDoc.playerId,
      conversationId: activeConversation.id,
    });

    return {
      inputId,
      conversationId: activeConversation.id,
      playerId: tokenDoc.playerId,
    };
  },
});

export const getNpcToken = query({
  args: {
    sessionToken: v.string(),
    botTokenId: v.id('botTokens'),
  },
  handler: async (ctx, args) => {
    const sessionToken = args.sessionToken.trim();
    if (!sessionToken) {
      throw new Error('sessionToken 不能为空');
    }

    const user = await validateSession({ db: ctx.db }, sessionToken);
    if (!user) {
      throw new Error('会话无效或已过期');
    }

    const tokenDoc = await ctx.db.get(args.botTokenId);
    if (!tokenDoc) {
      throw new Error('botToken 不存在');
    }
    if (!tokenDoc.userId || tokenDoc.userId !== user.userId) {
      throw new Error('无权访问该 botToken');
    }

    return {
      token: tokenDoc.token,
    };
  },
});

export const optionsNpc = httpAction(async (_ctx, request: Request) => {
  return corsPreflightResponse(request);
});

export const postNpcCreate = httpAction(async (ctx, request: Request) => {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return unauthorized('AUTH_FAILED', 'Missing session token', request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON', request);
  }

  const parsedBody = parseNpcCreateBody(body);
  if (!parsedBody) {
    return badRequest('INVALID_ARGS', 'Invalid request body', request);
  }

  const traceContext = {
    source: 'http:/api/npc/create',
    requestPath: new URL(request.url).pathname,
    requestMethod: request.method,
    userAgent: request.headers.get('user-agent') ?? undefined,
    origin: request.headers.get('origin') ?? undefined,
  };

  console.info('[NPC_CREATE_TRACE] http_request', {
    requestPath: traceContext.requestPath,
    requestMethod: traceContext.requestMethod,
    userAgent: traceContext.userAgent,
    origin: traceContext.origin,
    hasCharacter:
      typeof parsedBody.character === 'string' && parsedBody.character.trim().length > 0,
    name: parsedBody.name,
    ts: Date.now(),
  });

  try {
    const actionArgs: NpcCreateArgs = {
      sessionToken,
      name: parsedBody.name,
      character: parsedBody.character,
      traceContext,
    };
    const result = await ctx.runAction(api.npcService.createNpcWithToken, actionArgs);
    return jsonResponse({ ok: true, ...result }, undefined, request);
  } catch (e: unknown) {
    const message = toErrorMessage(e, '创建 NPC 失败');
    console.warn('[NPC_CREATE_TRACE] http_error', {
      requestPath: traceContext.requestPath,
      requestMethod: traceContext.requestMethod,
      message,
      ts: Date.now(),
    });
    if (message.includes('会话无效') || message.includes('已过期')) {
      return unauthorized('AUTH_FAILED', '会话无效或已过期', request);
    }
    if (message.includes('character') || message.includes('名称')) {
      return badRequest('INVALID_ARGS', message, request);
    }
    if (message.includes('超时')) {
      return internalError('NPC_CREATE_TIMEOUT', '创建 NPC 超时，请稍后重试', request);
    }
    if (message.includes('默认世界') || message.includes('世界不存在')) {
      return internalError('WORLD_NOT_FOUND', '创建 NPC 失败，请稍后重试', request);
    }
    if (message.includes('世界未运行')) {
      return internalError('WORLD_NOT_RUNNING', '创建 NPC 失败，请稍后重试', request);
    }
    return internalError('NPC_CREATE_FAILED', '创建 NPC 失败，请稍后重试', request);
  }
});

export const getNpcList = httpAction(async (ctx, request: Request) => {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return unauthorized('AUTH_FAILED', 'Missing session token', request);
  }

  try {
    const items = await ctx.runQuery(api.npcService.listMyNpcs, {
      sessionToken,
    });
    return jsonResponse({ ok: true, items }, undefined, request);
  } catch (e: unknown) {
    const message = toErrorMessage(e, '查询 NPC 列表失败');
    if (message.includes('会话无效') || message.includes('已过期')) {
      return unauthorized('AUTH_FAILED', '会话无效或已过期', request);
    }
    return internalError('LIST_FAILED', '查询 NPC 列表失败，请稍后重试', request);
  }
});

export const postNpcResetToken = httpAction(async (ctx, request: Request) => {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return unauthorized('AUTH_FAILED', 'Missing session token', request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON', request);
  }

  const parsedBody = parseNpcTokenBody(body);
  if (!parsedBody) {
    return badRequest('INVALID_ARGS', 'Missing botTokenId', request);
  }

  try {
    const result = await ctx.runMutation(api.npcService.resetNpcToken, {
      sessionToken,
      botTokenId: parsedBody.botTokenId as Id<'botTokens'>,
    });
    return jsonResponse({ ok: true, token: result.token }, undefined, request);
  } catch (e: unknown) {
    const message = toErrorMessage(e, '重置 token 失败');
    if (message.includes('会话无效') || message.includes('已过期')) {
      return unauthorized('AUTH_FAILED', '会话无效或已过期', request);
    }
    if (message.includes('无权')) {
      return forbidden('FORBIDDEN', message, request);
    }
    if (message.includes('不存在')) {
      return badRequest('NOT_FOUND', message, request);
    }
    return internalError('RESET_FAILED', '重置 token 失败，请稍后重试', request);
  }
});

export const postNpcInterrupt = httpAction(async (ctx, request: Request) => {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return unauthorized('AUTH_FAILED', 'Missing session token', request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON', request);
  }

  const parsedBody = parseNpcTokenBody(body);
  if (!parsedBody) {
    return badRequest('INVALID_ARGS', 'Missing botTokenId', request);
  }

  try {
    const result = await ctx.runMutation(api.npcService.interruptNpcConversation, {
      sessionToken,
      botTokenId: parsedBody.botTokenId as Id<'botTokens'>,
    });
    return jsonResponse({ ok: true, ...result }, undefined, request);
  } catch (e: unknown) {
    const message = toErrorMessage(e, '打断对话失败');
    if (message.includes('会话无效') || message.includes('已过期')) {
      return unauthorized('AUTH_FAILED', '会话无效或已过期', request);
    }
    if (message.includes('无权')) {
      return forbidden('FORBIDDEN', message, request);
    }
    if (message.includes('不在进行中的对话')) {
      return badRequest('NO_ACTIVE_CONVERSATION', message, request);
    }
    if (message.includes('不存在')) {
      return badRequest('NOT_FOUND', message, request);
    }
    return internalError('INTERRUPT_FAILED', '打断对话失败，请稍后重试', request);
  }
});

export const getNpcTokenById = httpAction(async (ctx, request: Request) => {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return unauthorized('AUTH_FAILED', 'Missing session token', request);
  }

  const url = new URL(request.url);
  const prefix = '/api/npc/token/';
  if (!url.pathname.startsWith(prefix)) {
    return badRequest('NOT_FOUND', 'Route not matched', request);
  }

  let botTokenId = '';
  try {
    botTokenId = decodeURIComponent(url.pathname.slice(prefix.length)).trim();
  } catch {
    return badRequest('INVALID_ARGS', 'Invalid token id encoding', request);
  }
  if (!botTokenId) {
    return badRequest('INVALID_ARGS', 'Missing token id', request);
  }

  try {
    const result = await ctx.runQuery(api.npcService.getNpcToken, {
      sessionToken,
      botTokenId: botTokenId as Id<'botTokens'>,
    });
    return jsonResponse({ ok: true, token: result.token }, undefined, request);
  } catch (e: unknown) {
    const message = toErrorMessage(e, '获取 token 失败');
    if (message.includes('会话无效') || message.includes('已过期')) {
      return unauthorized('AUTH_FAILED', '会话无效或已过期', request);
    }
    if (message.includes('无权')) {
      return forbidden('FORBIDDEN', message, request);
    }
    if (message.includes('不存在')) {
      return badRequest('NOT_FOUND', message, request);
    }
    return internalError('GET_TOKEN_FAILED', '获取 token 失败，请稍后重试', request);
  }
});

