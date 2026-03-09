import { api } from '../_generated/api';
import { httpAction } from '../_generated/server';
import { extractSessionToken } from '../auth';

const assetApi = (api as any).assets?.queries;

function buildCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    ...(origin ? { vary: 'origin' } : {}),
  };
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

function badRequest(code: string, message: string, request: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 400 }, request);
}

function unauthorized(code: string, message: string, request: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 401 }, request);
}

function internalError(code: string, message: string, request: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 500 }, request);
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

function ensureAssetApi() {
  if (!assetApi) {
    throw new Error('资源查询 API 未生成，请先同步 Convex 生成文件');
  }
  return assetApi;
}

function readOptionalSessionToken(request: Request): string | undefined {
  const token = extractSessionToken(request);
  if (!token) {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed || undefined;
}

function requireSessionToken(request: Request): string | Response {
  const token = readOptionalSessionToken(request);
  if (!token) {
    return unauthorized('UNAUTHORIZED', '未登录，无法访问个人资源', request);
  }
  return token;
}

function readStatusFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  if (typeof status !== 'string') {
    return null;
  }
  const trimmed = status.trim();
  return trimmed || null;
}

async function runAssetListQuery(ctx: any, request: Request, queryRef: any, requireAuth: boolean) {
  const status = readStatusFromRequest(request);
  if (!status) {
    return badRequest('INVALID_ARGS', '缺少 status 参数', request);
  }

  const sessionTokenOrResponse = requireAuth ? requireSessionToken(request) : readOptionalSessionToken(request);
  if (sessionTokenOrResponse instanceof Response) {
    return sessionTokenOrResponse;
  }

  try {
    const result = await ctx.runQuery(queryRef, {
      status,
      ...(sessionTokenOrResponse ? { sessionToken: sessionTokenOrResponse } : {}),
    });
    return jsonResponse(result, undefined, request);
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '资源查询失败');
    if (message.includes('未登录') || message.includes('无权')) {
      return unauthorized('UNAUTHORIZED', message, request);
    }
    return internalError('ASSET_LIST_FAILED', message, request);
  }
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export const optionsAssets = httpAction(async (_ctx, request) => {
  return corsPreflightResponse(request);
});

export const getTilesetsHttp = httpAction(async (ctx, request) => {
  const status = readStatusFromRequest(request);
  const requireAuth = status !== 'published';
  const queries = ensureAssetApi();
  return await runAssetListQuery(ctx, request, queries.listTilesets, requireAuth);
});

export const getSceneAnimationsHttp = httpAction(async (ctx, request) => {
  const status = readStatusFromRequest(request);
  const requireAuth = status !== 'published';
  const queries = ensureAssetApi();
  return await runAssetListQuery(ctx, request, queries.listSceneAnimations, requireAuth);
});

export const postTilesetDetailHttp = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return badRequest('INVALID_ARGS', '缺少资源 id', request);
  }

  const sessionToken = readOptionalSessionToken(request);
  const queries = ensureAssetApi();

  try {
    const result = await ctx.runQuery(queries.getTilesetDetail, {
      id,
      ...(sessionToken ? { sessionToken } : {}),
    });
    return jsonResponse(result, undefined, request);
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '资源详情查询失败');
    if (message.includes('无权查看') || message.includes('未登录')) {
      return unauthorized('UNAUTHORIZED', message, request);
    }
    return internalError('ASSET_DETAIL_FAILED', message, request);
  }
});

export const postSceneAnimationDetailHttp = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return badRequest('INVALID_ARGS', '缺少资源 id', request);
  }

  const sessionToken = readOptionalSessionToken(request);
  const queries = ensureAssetApi();

  try {
    const result = await ctx.runQuery(queries.getSceneAnimationDetail, {
      id,
      ...(sessionToken ? { sessionToken } : {}),
    });
    return jsonResponse(result, undefined, request);
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '资源详情查询失败');
    if (message.includes('无权查看') || message.includes('未登录')) {
      return unauthorized('UNAUTHORIZED', message, request);
    }
    return internalError('ASSET_DETAIL_FAILED', message, request);
  }
});

export const postAssetFileUrlHttp = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const assetKind = typeof body?.assetKind === 'string' ? body.assetKind.trim() : '';
  const storageId = typeof body?.storageId === 'string' ? body.storageId.trim() : '';

  if (!assetKind || !storageId) {
    return badRequest('INVALID_ARGS', '缺少 assetKind 或 storageId', request);
  }

  const sessionToken = readOptionalSessionToken(request);
  const queries = ensureAssetApi();

  try {
    const result = await ctx.runQuery(queries.getAssetFileUrl, {
      assetKind,
      storageId,
      ...(sessionToken ? { sessionToken } : {}),
    });
    return jsonResponse(result, undefined, request);
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '资源文件地址查询失败');
    if (message.includes('无权查看') || message.includes('未登录')) {
      return unauthorized('UNAUTHORIZED', message, request);
    }
    return internalError('ASSET_FILE_URL_FAILED', message, request);
  }
});
