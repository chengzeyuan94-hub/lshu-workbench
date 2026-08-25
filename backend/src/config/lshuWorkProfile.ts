export const LSHU_WORK_PROFILE = {
  version: 'open-source-profile-v1',
  generatedAt: '2026-08-25',
  role: '内容创作者与个人项目经营者',
  coreDomains: [
    '内容策划、增长和商业化',
    '文章、视频、播客与社交媒体内容生产',
    '课程、产品、社群与个人项目运营',
    '设计、开发、协作和交付',
    '复盘、数据分析与经营决策',
  ],
  workingStyle: {
    dailyFocusLimit: 5,
    preferredFocusMinutes: [45, 60, 90],
    morningStrengths: ['课程结构', '写作', '策略', '核心产品设计'],
    afternoonStrengths: ['开发', '素材制作', '协作', '运营', '交付'],
    bufferRatio: 0.2,
    avoid: [
      '连续堆叠多个高强度创作任务',
      '把普通文件变化或聊天摘要当成待办',
      '用低价值杂事填满全部可用时间',
    ],
  },
  planningPrinciples: [
    '优先选择有明确交付物、期限或外部承诺的事项',
    '每天最多保留五件主任务，固定会议与日历事件另计',
    '上午优先深度思考与创作，下午优先制作、开发、协作和交付',
    '为突发沟通和创作返工保留至少百分之二十缓冲',
    '同类事项可相邻安排，但避免多个重创作事项连续消耗',
  ],
  evidenceSummary: {
    desktopFilesObserved: 0,
    latestWorkbenchScanFiles: 0,
    dominantAssetTypes: [],
    observation: '开源发行版使用中性示例画像。请只在本地按自己的工作习惯修改；不要提交真实文件名、路径或聊天正文。',
  },
} as const;

export type LshuWorkProfile = typeof LSHU_WORK_PROFILE;
