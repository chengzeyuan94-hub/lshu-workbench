import type { CreatorMetric, CreatorProfile, NotePerformance } from './types';

// 演示数据：当 OpenCLI / 登录态不可用时提供，保证界面可完整预览
export function demoProfile(): CreatorProfile {
  return {
    name: '示例创作者',
    followers: 12500,
    following: 320,
    likesCollects: 38600,
    creatorLevel: 3,
    levelProgress: 'demo',
    bio: '这是不对应任何真实账号的本地演示资料。',
  };
}

export function demoMetrics(): CreatorMetric[] {
  const mk = (key: string, label: string, total: number, trend: number[]): CreatorMetric => ({
    key,
    label,
    total,
    trend,
  });
  return [
    mk('views', '观看数 (views)', 4983, [722, 669, 811, 637, 747, 741, 656]),
    mk('likes', '点赞数 (likes)', 109, [13, 11, 20, 15, 16, 12, 22]),
    mk('collects', '收藏数 (collects)', 68, [13, 10, 10, 7, 5, 9, 14]),
    mk('comments', '评论数 (comments)', 0, [0, 0, 0, 0, 0, 0, 0]),
    mk('shares', '分享数 (shares)', 20, [4, 0, 3, 3, 2, 5, 3]),
    mk('new_followers', '涨粉数 (new followers)', 33, [4, 4, 5, 3, 6, 4, 7]),
  ];
}

export function demoNotes(): NotePerformance[] {
  const mk = (
    rank: number,
    id: string,
    title: string,
    date: string,
    views: number,
    likes: number,
    collects: number,
    comments: number
  ): NotePerformance => ({
    rank,
    id,
    title,
    date,
    views,
    likes,
    collects,
    comments,
    url: `https://creator.xiaohongshu.com/statistics/note-detail?noteId=${id}`,
    collectRate: views > 0 ? (collects / views) * 100 : 0,
    lowPerformance: views > 0 && views < 500,
  });

  return [
    mk(1, '000000000000000000000101', '示例笔记：三步完成内容复盘', '2026年05月14日 17:35', 11790, 384, 387, 9),
    mk(2, '000000000000000000000102', '示例笔记：一周创作工作流', '2026年05月04日 21:51', 6828, 279, 181, 9),
    mk(3, '000000000000000000000103', '示例笔记：桌面效率工具清单', '2026年05月02日 17:24', 28906, 829, 792, 15),
    mk(4, '000000000000000000000104', '示例笔记：从选题到发布', '2026年04月22日 18:41', 11753, 451, 343, 3),
    mk(5, '000000000000000000000105', '示例笔记：个人项目周报', '2026年04月21日 16:41', 32332, 862, 851, 49),
    mk(6, '000000000000000000000106', '示例笔记：低表现内容诊断', '2026年04月10日 12:20', 380, 25, 12, 2),
  ];
}
