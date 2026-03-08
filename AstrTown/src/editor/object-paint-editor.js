import * as CONFIG from './leconfig.js';

let editorCtx = null;

function createDefaultOccupiedTiles() {
    return [{ dx: 0, dy: 0 }];
}

function createAppearanceDraft() {
    return {
        renderType: 'static',
        sourceType: 'tileset',
        sheet: null,
        animationName: null,
        frameConfig: {
            x: 0,
            y: 0,
            w: 32,
            h: 32,
        },
        anchorX: 0.5,
        anchorY: 0.5,
        previewScale: 1,
    };
}

function cloneOccupiedTiles(tiles) {
    if (!Array.isArray(tiles) || tiles.length === 0) {
        return createDefaultOccupiedTiles();
    }
    return tiles.map((item) => ({
        dx: Number(item?.dx) || 0,
        dy: Number(item?.dy) || 0,
    }));
}

function cloneAppearance(appearance = {}) {
    const frame = appearance.frameConfig || {};
    return {
        renderType: ['none', 'static', 'animated'].includes(appearance.renderType)
            ? appearance.renderType
            : 'static',
        sourceType: ['tileset', 'spritesheet'].includes(appearance.sourceType)
            ? appearance.sourceType
            : 'tileset',
        sheet: appearance.sheet || appearance.tileSetUrl || null,
        animationName: appearance.animationName || null,
        frameConfig: {
            x: Number(frame.x) || 0,
            y: Number(frame.y) || 0,
            w: Math.max(1, Number(frame.w ?? frame.width) || 32),
            h: Math.max(1, Number(frame.h ?? frame.height) || 32),
        },
        anchorX: Number.isFinite(Number(appearance.anchorX)) ? Number(appearance.anchorX) : 0.5,
        anchorY: Number.isFinite(Number(appearance.anchorY)) ? Number(appearance.anchorY) : 0.5,
        previewScale: Math.max(0.1, Number(appearance.previewScale) || 1),
    };
}

function createDraftTemplate() {
    return {
        catalogKey: null,
        name: '',
        category: '',
        description: '',
        occupiedTiles: createDefaultOccupiedTiles(),
        blocksMovement: true,
        appearance: createAppearanceDraft(),
        parts: [],
        dirty: false,
    };
}

function ensureEditorCtx() {
    if (!editorCtx) {
        throw new Error('object-paint-editor 尚未初始化');
    }
    return editorCtx;
}

function ensureDraft() {
    const ctx = ensureEditorCtx();
    if (!ctx.g_ctx.objectPaintDraft) {
        ctx.g_ctx.objectPaintDraft = createNewObjectDraft();
    }
    return ctx.g_ctx.objectPaintDraft;
}

function getStage() {
    return ensureEditorCtx().g_ctx.composite?.workspaceStages?.objectPaintStage || null;
}

function getDom() {
    return ensureEditorCtx().dom;
}

function markDirty(flag = true) {
    const draft = ensureDraft();
    draft.dirty = !!flag;
}

function getResourceRegistry() {
    const ctx = ensureEditorCtx();
    return typeof ctx.g_ctx.getResourceRegistry === 'function'
        ? ctx.g_ctx.getResourceRegistry()
        : { tilesets: [], spritesheets: [], activeTileset: null, activeSpritesheet: null };
}

function findCatalogItemByKey(catalogKey) {
    const ctx = ensureEditorCtx();
    const catalog = ctx.semanticUI?.getCatalogItems?.() || [];
    return catalog.find((item) => item.key === catalogKey) || null;
}

function deriveDraftKey(draft) {
    if (draft.catalogKey && String(draft.catalogKey).trim()) {
        return String(draft.catalogKey).trim();
    }
    const source = String(draft.name || '').trim();
    if (!source) {
        return '';
    }
    return source
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '')
        .toLowerCase();
}

function getOccupiedBounds(tiles) {
    const list = cloneOccupiedTiles(tiles);
    let minDx = list[0].dx;
    let minDy = list[0].dy;
    let maxDx = list[0].dx;
    let maxDy = list[0].dy;
    list.forEach((item) => {
        minDx = Math.min(minDx, item.dx);
        minDy = Math.min(minDy, item.dy);
        maxDx = Math.max(maxDx, item.dx);
        maxDy = Math.max(maxDy, item.dy);
    });
    return {
        minDx,
        minDy,
        maxDx,
        maxDy,
        width: maxDx - minDx + 1,
        height: maxDy - minDy + 1,
    };
}

function updateOccupiedMetaLabel() {
    const dom = getDom();
    if (!dom.occupiedLabel) {
        return;
    }
    const bounds = getOccupiedBounds(ensureDraft().occupiedTiles);
    dom.occupiedLabel.textContent = `${bounds.width} × ${bounds.height}`;
}

function clearStage() {
    const stage = getStage();
    if (stage) {
        stage.removeChildren();
    }
}

function destroyPreviewObject() {
    const ctx = ensureEditorCtx();
    if (ctx.previewObject) {
        if (ctx.previewObject instanceof ctx.PIXI.AnimatedSprite) {
            ctx.previewObject.stop();
        }
        ctx.previewObject.destroy({
            children: true,
            texture: false,
            textureSource: false,
        });
        ctx.previewObject = null;
    }
}

function createStaticTexture(appearance) {
    if (!appearance.sheet) {
        return null;
    }
    const ctx = ensureEditorCtx();
    const frame = appearance.frameConfig;
    const cacheKey = `${appearance.sheet}|${frame.x},${frame.y},${frame.w},${frame.h}`;
    if (ctx.textureCache.staticTextureByKey.has(cacheKey)) {
        return ctx.textureCache.staticTextureByKey.get(cacheKey);
    }
    let baseTexture = ctx.textureCache.baseTextureByUrl.get(appearance.sheet);
    if (!baseTexture) {
        baseTexture = ctx.PIXI.BaseTexture.from(appearance.sheet, {
            scaleMode: ctx.PIXI.SCALE_MODES.NEAREST,
        });
        ctx.textureCache.baseTextureByUrl.set(appearance.sheet, baseTexture);
    }
    const texture = new ctx.PIXI.Texture(
        baseTexture,
        new ctx.PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
    );
    ctx.textureCache.staticTextureByKey.set(cacheKey, texture);
    return texture;
}

function createAnimatedFrames(appearance) {
    if (!appearance.sheet || !appearance.animationName) {
        return null;
    }
    const registry = getResourceRegistry();
    const sheetEntry = (registry.spritesheets || []).find((item) => item.name === appearance.sheet || item.key === appearance.sheet);
    return sheetEntry?.sheet?.animations?.[appearance.animationName] || null;
}

function createPreviewDisplayObject() {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const appearance = draft.appearance || createAppearanceDraft();

    if (appearance.renderType === 'none') {
        return null;
    }

    if (appearance.renderType === 'animated') {
        const frames = createAnimatedFrames(appearance);
        if (!Array.isArray(frames) || frames.length === 0) {
            return null;
        }
        const preview = new ctx.PIXI.AnimatedSprite(frames);
        preview.animationSpeed = 0.1;
        preview.loop = true;
        preview.play();
        return preview;
    }

    const texture = createStaticTexture(appearance);
    if (!texture) {
        return null;
    }
    return new ctx.PIXI.Sprite(texture);
}

function renderEmptyHint(stage, message) {
    const ctx = ensureEditorCtx();
    const text = new ctx.PIXI.Text(message, {
        fontFamily: 'Consolas, monospace',
        fontSize: 14,
        fill: 0x94a3b8,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 320,
    });
    text.anchor.set(0.5, 0.5);
    text.x = CONFIG.levelwidth / 2;
    text.y = CONFIG.levelheight / 2;
    stage.addChild(text);
}

function renderGrid(stage) {
    const ctx = ensureEditorCtx();
    const grid = new ctx.PIXI.Graphics();
    const tileW = ctx.g_ctx.tiledimx || 32;
    const tileH = ctx.g_ctx.tiledimy || 32;
    const width = CONFIG.levelwidth;
    const height = CONFIG.levelheight;
    grid.lineStyle(1, 0xffffff, 0.08);
    for (let x = 0; x <= width; x += tileW) {
        grid.moveTo(x, 0);
        grid.lineTo(x, height);
    }
    for (let y = 0; y <= height; y += tileH) {
        grid.moveTo(0, y);
        grid.lineTo(width, y);
    }
    stage.addChild(grid);
}

function renderOccupiedOverlay(stage) {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const tileW = ctx.g_ctx.tiledimx || 32;
    const tileH = ctx.g_ctx.tiledimy || 32;
    const centerX = Math.floor(CONFIG.levelwidth / 2 / tileW) * tileW;
    const centerY = Math.floor(CONFIG.levelheight / 2 / tileH) * tileH;
    const overlay = new ctx.PIXI.Graphics();

    overlay.lineStyle(2, 0x38bdf8, 0.95);
    draft.occupiedTiles.forEach((item) => {
        const x = centerX + item.dx * tileW;
        const y = centerY + item.dy * tileH;
        overlay.beginFill(0x38bdf8, 0.08);
        overlay.drawRect(x, y, tileW, tileH);
        overlay.endFill();
        overlay.drawRect(x, y, tileW, tileH);
    });

    stage.addChild(overlay);
}

function renderAnchorOverlay(stage) {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const appearance = draft.appearance || createAppearanceDraft();
    const frame = appearance.frameConfig || { w: 32, h: 32 };
    const scale = Math.max(0.1, Number(appearance.previewScale) || 1);
    const centerX = CONFIG.levelwidth / 2;
    const centerY = CONFIG.levelheight / 2;
    const anchorX = centerX + ((appearance.anchorX || 0) - 0.5) * frame.w * scale;
    const anchorY = centerY + ((appearance.anchorY || 0) - 0.5) * frame.h * scale;
    const cross = new ctx.PIXI.Graphics();
    cross.lineStyle(2, 0xef4444, 1);
    cross.moveTo(anchorX - 10, anchorY);
    cross.lineTo(anchorX + 10, anchorY);
    cross.moveTo(anchorX, anchorY - 10);
    cross.lineTo(anchorX, anchorY + 10);
    stage.addChild(cross);
}

function positionPreviewObject(displayObject) {
    const draft = ensureDraft();
    const appearance = draft.appearance || createAppearanceDraft();
    const scale = Math.max(0.1, Number(appearance.previewScale) || 1);
    if (typeof displayObject.anchor?.set === 'function') {
        displayObject.anchor.set(appearance.anchorX, appearance.anchorY);
    }
    if (typeof displayObject.scale?.set === 'function') {
        displayObject.scale.set(scale, scale);
    }
    displayObject.x = CONFIG.levelwidth / 2;
    displayObject.y = CONFIG.levelheight / 2;
}

function syncDraftFromForm() {
    const draft = ensureDraft();
    const dom = getDom();
    const currentKey = deriveDraftKey(draft);

    if (dom.catalogKeyLabel) {
        dom.catalogKeyLabel.value = currentKey;
    }
    if (dom.nameInput) {
        draft.name = dom.nameInput.value.trim();
    }
    if (dom.categoryInput) {
        draft.category = dom.categoryInput.value.trim();
    }
    if (dom.descriptionInput) {
        draft.description = dom.descriptionInput.value.trim();
    }
    if (dom.blocksMovementInput) {
        draft.blocksMovement = !!dom.blocksMovementInput.checked;
    }
    if (dom.previewScaleInput) {
        draft.appearance.previewScale = Math.max(0.1, Number(dom.previewScaleInput.value) || 1);
        dom.previewScaleInput.value = String(draft.appearance.previewScale);
    }
    if (dom.anchorXInput) {
        draft.appearance.anchorX = Number(dom.anchorXInput.value);
    }
    if (dom.anchorYInput) {
        draft.appearance.anchorY = Number(dom.anchorYInput.value);
    }
    if (dom.occupiedWidthInput || dom.occupiedHeightInput) {
        const width = Math.max(1, Number(dom.occupiedWidthInput?.value) || 1);
        const height = Math.max(1, Number(dom.occupiedHeightInput?.value) || 1);
        if (dom.occupiedWidthInput) {
            dom.occupiedWidthInput.value = String(width);
        }
        if (dom.occupiedHeightInput) {
            dom.occupiedHeightInput.value = String(height);
        }
        draft.occupiedTiles = buildRectOccupiedTiles(width, height);
    }
}

function fillFormFromDraft() {
    const draft = ensureDraft();
    const dom = getDom();
    const bounds = getOccupiedBounds(draft.occupiedTiles);

    if (dom.catalogKeyLabel) {
        dom.catalogKeyLabel.value = deriveDraftKey(draft);
    }
    if (dom.nameInput) {
        dom.nameInput.value = draft.name || '';
    }
    if (dom.categoryInput) {
        dom.categoryInput.value = draft.category || '';
    }
    if (dom.descriptionInput) {
        dom.descriptionInput.value = draft.description || '';
    }
    if (dom.blocksMovementInput) {
        dom.blocksMovementInput.checked = !!draft.blocksMovement;
    }
    if (dom.previewScaleInput) {
        dom.previewScaleInput.value = String(draft.appearance.previewScale || 1);
    }
    if (dom.anchorXInput) {
        dom.anchorXInput.value = String(draft.appearance.anchorX ?? 0.5);
    }
    if (dom.anchorYInput) {
        dom.anchorYInput.value = String(draft.appearance.anchorY ?? 0.5);
    }
    if (dom.occupiedWidthInput) {
        dom.occupiedWidthInput.value = String(bounds.width);
    }
    if (dom.occupiedHeightInput) {
        dom.occupiedHeightInput.value = String(bounds.height);
    }
    if (dom.renderTypeLabel) {
        dom.renderTypeLabel.textContent = draft.appearance.renderType === 'animated' ? '动画' : (draft.appearance.renderType === 'none' ? '无' : '静态贴图');
    }
    if (dom.sourceLabel) {
        dom.sourceLabel.textContent = draft.appearance.sheet || '未选择资源';
    }
    if (dom.animationLabel) {
        dom.animationLabel.textContent = draft.appearance.animationName || '无';
    }
    updateOccupiedMetaLabel();
}

function refreshEditorUI() {
    syncDraftFromForm();
    fillFormFromDraft();
    renderObjectPaintPreview();
}

function bindDomEvents() {
    const dom = getDom();
    const inputNodes = [
        dom.nameInput,
        dom.categoryInput,
        dom.descriptionInput,
        dom.blocksMovementInput,
        dom.previewScaleInput,
        dom.anchorXInput,
        dom.anchorYInput,
        dom.occupiedWidthInput,
        dom.occupiedHeightInput,
    ].filter(Boolean);

    inputNodes.forEach((node) => {
        const eventName = node.type === 'checkbox' ? 'change' : 'input';
        node.addEventListener(eventName, () => {
            syncDraftFromForm();
            markDirty(true);
            refreshEditorUI();
        });
    });

    if (dom.newDraftButton) {
        dom.newDraftButton.addEventListener('click', () => {
            const ctx = ensureEditorCtx();
            ctx.g_ctx.objectPaintDraft = createNewObjectDraft();
            refreshEditorUI();
        });
    }

    if (dom.saveButton) {
        dom.saveButton.addEventListener('click', () => {
            saveObjectTemplate();
        });
    }

    if (dom.placeButton) {
        dom.placeButton.addEventListener('click', () => {
            switchToPlacementMode();
        });
    }
}

function buildRectOccupiedTiles(width, height) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const tiles = [];
    for (let dy = 0; dy < safeHeight; dy += 1) {
        for (let dx = 0; dx < safeWidth; dx += 1) {
            tiles.push({ dx, dy });
        }
    }
    return tiles;
}

export function initObjectPaintEditor(g_ctx, PIXI, semanticUI) {
    editorCtx = {
        g_ctx,
        PIXI,
        semanticUI,
        previewObject: null,
        textureCache: {
            baseTextureByUrl: new Map(),
            staticTextureByKey: new Map(),
        },
        dom: {
            panel: document.getElementById('object-paint-editor-panel'),
            catalogKeyLabel: document.getElementById('object-paint-catalog-key'),
            nameInput: document.getElementById('object-paint-name'),
            categoryInput: document.getElementById('object-paint-category'),
            descriptionInput: document.getElementById('object-paint-description'),
            occupiedWidthInput: document.getElementById('object-paint-occupied-width'),
            occupiedHeightInput: document.getElementById('object-paint-occupied-height'),
            occupiedLabel: document.getElementById('object-paint-occupied-size-label'),
            blocksMovementInput: document.getElementById('object-paint-blocks-movement'),
            anchorXInput: document.getElementById('object-paint-anchor-x'),
            anchorYInput: document.getElementById('object-paint-anchor-y'),
            previewScaleInput: document.getElementById('object-paint-preview-scale'),
            renderTypeLabel: document.getElementById('object-paint-render-type'),
            sourceLabel: document.getElementById('object-paint-source'),
            animationLabel: document.getElementById('object-paint-animation'),
            saveButton: document.getElementById('object-paint-save-template'),
            placeButton: document.getElementById('object-paint-switch-placement'),
            newDraftButton: document.getElementById('object-paint-new-draft'),
        },
    };

    g_ctx.objectPaintDraft = createNewObjectDraft();
    g_ctx.refreshObjectPaintEditorUI = refreshEditorUI;
    g_ctx.renderObjectPaintPreview = renderObjectPaintPreview;
    g_ctx.applyObjectPaintTileAppearance = applyTileAsAppearance;
    g_ctx.applyObjectPaintAnimationAppearance = applyAnimationAsAppearance;
    g_ctx.loadObjectPaintDraftFromCatalog = loadFromCatalog;
    g_ctx.handleObjectPaintWorkspacePointer = () => {};
    bindDomEvents();
    refreshEditorUI();
}

export function createNewObjectDraft() {
    return createDraftTemplate();
}

export function loadFromCatalog(catalogKey) {
    const item = findCatalogItemByKey(catalogKey);
    if (!item) {
        return null;
    }
    const ctx = ensureEditorCtx();
    ctx.g_ctx.objectPaintDraft = {
        catalogKey: item.key,
        name: item.name || '',
        category: item.category || '',
        description: item.description || '',
        occupiedTiles: cloneOccupiedTiles(item.occupiedTiles),
        blocksMovement: item.blocksMovement !== false,
        appearance: cloneAppearance(item.appearance || item),
        parts: Array.isArray(item.parts) ? item.parts.map((part) => ({ ...part })) : [],
        dirty: false,
    };
    refreshEditorUI();
    return ctx.g_ctx.objectPaintDraft;
}

export function applyTileAsAppearance(tileX, tileY, tileset) {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const tileW = ctx.g_ctx.tiledimx || 32;
    const tileH = ctx.g_ctx.tiledimy || 32;
    if (!tileset) {
        return null;
    }
    draft.appearance.renderType = 'static';
    draft.appearance.sourceType = 'tileset';
    draft.appearance.sheet = tileset;
    draft.appearance.animationName = null;
    draft.appearance.frameConfig = {
        x: Math.max(0, Number(tileX) || 0) * tileW,
        y: Math.max(0, Number(tileY) || 0) * tileH,
        w: tileW,
        h: tileH,
    };
    markDirty(true);
    refreshEditorUI();
    return draft.appearance;
}

export function applyAnimationAsAppearance(animationName, spritesheet) {
    const draft = ensureDraft();
    if (!animationName || !spritesheet) {
        return null;
    }
    draft.appearance.renderType = 'animated';
    draft.appearance.sourceType = 'spritesheet';
    draft.appearance.sheet = spritesheet;
    draft.appearance.animationName = animationName;
    markDirty(true);
    refreshEditorUI();
    return draft.appearance;
}

export function setAnchor(anchorX, anchorY) {
    const draft = ensureDraft();
    draft.appearance.anchorX = Math.max(0, Math.min(1, Number(anchorX) || 0));
    draft.appearance.anchorY = Math.max(0, Math.min(1, Number(anchorY) || 0));
    markDirty(true);
    refreshEditorUI();
    return draft.appearance;
}

export function setOccupiedTiles(tiles) {
    const draft = ensureDraft();
    draft.occupiedTiles = cloneOccupiedTiles(tiles);
    markDirty(true);
    refreshEditorUI();
    return draft.occupiedTiles;
}

export function renderObjectPaintPreview() {
    const stage = getStage();
    if (!stage) {
        return;
    }
    clearStage();
    destroyPreviewObject();

    renderGrid(stage);
    renderOccupiedOverlay(stage);

    const previewObject = createPreviewDisplayObject();
    if (previewObject) {
        positionPreviewObject(previewObject);
        stage.addChild(previewObject);
        ensureEditorCtx().previewObject = previewObject;
    } else {
        renderEmptyHint(stage, '请从底部资源区选择瓦片或动画\n作为当前物体外观');
    }

    renderAnchorOverlay(stage);
}

export function saveObjectTemplate() {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    syncDraftFromForm();

    const key = deriveDraftKey(draft);
    if (!key) {
        window.alert('请先填写物体名称');
        return null;
    }
    if (!draft.name) {
        window.alert('物体名称不能为空');
        return null;
    }
    if (!draft.appearance.sheet && draft.appearance.renderType !== 'none') {
        window.alert('请先从资源区应用外观');
        return null;
    }

    const payload = {
        key,
        name: draft.name,
        category: draft.category || 'default',
        description: draft.description || '',
        interactionHint: '',
        occupiedTiles: draft.occupiedTiles
            .map((item) => `${item.dx},${item.dy}`)
            .join('\n'),
        blocksMovement: !!draft.blocksMovement,
        appearanceRenderType: draft.appearance.renderType,
        appearanceSourceType: draft.appearance.sourceType,
        appearanceSheet: draft.appearance.sheet || '',
        appearanceAnimationName: draft.appearance.animationName || '',
        appearanceFrameX: String(draft.appearance.frameConfig.x || 0),
        appearanceFrameY: String(draft.appearance.frameConfig.y || 0),
        appearanceFrameWidth: String(draft.appearance.frameConfig.w || 32),
        appearanceFrameHeight: String(draft.appearance.frameConfig.h || 32),
        appearanceAnchorX: String(draft.appearance.anchorX ?? 0.5),
        appearanceAnchorY: String(draft.appearance.anchorY ?? 0.5),
        appearancePreviewScale: String(draft.appearance.previewScale || 1),
    };

    const saved = ctx.semanticUI?.upsertCatalogItem?.(payload) || null;
    if (!saved) {
        return null;
    }
    draft.catalogKey = saved.key;
    draft.appearance.sheet = saved.appearance?.sheet || draft.appearance.sheet;
    draft.appearance.animationName = saved.appearance?.animationName || draft.appearance.animationName;
    draft.dirty = false;
    if (typeof ctx.semanticUI?.refreshCatalog === 'function') {
        ctx.semanticUI.refreshCatalog();
    }
    if (typeof ctx.semanticUI?.selectCatalogItem === 'function') {
        ctx.semanticUI.selectCatalogItem(saved.key);
    }
    refreshEditorUI();
    return saved;
}

export function switchToPlacementMode() {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const key = draft.catalogKey || deriveDraftKey(draft);
    if (!key) {
        window.alert('请先保存物体模板后再切换到放置模式');
        return false;
    }
    if (typeof ctx.semanticUI?.selectCatalogItem === 'function') {
        ctx.semanticUI.selectCatalogItem(key);
    }
    if (typeof ctx.g_ctx.setWorkspaceModeFromObjectPaint === 'function') {
        ctx.g_ctx.setWorkspaceModeFromObjectPaint('object-place');
    }
    return true;
}
