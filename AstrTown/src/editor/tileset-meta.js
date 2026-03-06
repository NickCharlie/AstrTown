export const TILESET_ROI_BOOKMARKS = {
  './tilesets/gentle.png': [
    { category: '地表', label: '草地 / 路面', y: 0 },
    { category: '建筑', label: '墙体 / 屋顶', y: 768 },
    { category: '门窗', label: '门窗 / 装饰', y: 1664 },
    { category: '家具', label: '家具 / 室内', y: 2624 },
    { category: '自然', label: '树木 / 植被', y: 3776 },
    { category: '功能', label: '功能物件 / 特效', y: 5312 },
  ],
  './tilesets/magecity.png': [
    { category: '街道', label: '道路 / 地砖', y: 0 },
    { category: '建筑', label: '墙体 / 门面', y: 384 },
    { category: '装饰', label: '招牌 / 小物', y: 896 },
  ],
  './tilesets/forest.png': [
    { category: '地形', label: '地面 / 水域', y: 0 },
    { category: '植被', label: '树木 / 草丛', y: 640 },
    { category: '结构', label: '围栏 / 小屋', y: 1408 },
  ],
  './tilesets/Serene.png': [
    { category: '地表', label: '地砖 / 水面', y: 0 },
    { category: '建筑', label: '墙体 / 屋顶', y: 512 },
    { category: '细节', label: '装饰 / 道具', y: 1024 },
  ],
  './tilesets/Modern.png': [
    { category: '基础', label: '地面 / 墙面', y: 0 },
    { category: '室内', label: '家具 / 设施', y: 1600 },
    { category: '细节', label: '装饰 / 道具', y: 3200 },
  ],
};

export function getTilesetBookmarks(tilesetPath) {
  if (typeof tilesetPath !== 'string' || !tilesetPath.trim()) {
    return [];
  }

  const normalized = tilesetPath.trim();
  return TILESET_ROI_BOOKMARKS[normalized] || [];
}
