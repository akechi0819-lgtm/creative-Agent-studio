// 本轮内置生图生成的带画笔 v2；出处见 docs/design/鲸鱼主题与素材来源.md。
export function WhaleAvatar({ className = '', decorative = false }) {
  return <img className={`whale-avatar ${className}`} src="/brand/whale-artist.png" alt={decorative ? '' : '大肥鱼绘图助手'} decoding="async" draggable={false} />;
}
