// 社区角色新增素材与完整许可随 web/public/brand/characters 一并保留。
export function WhaleCharacter({ pose = 'portrait', className = '', decorative = true }) {
  const label = pose === 'busy' ? '鲸鱼娘正在工作' : pose === 'happy' ? '鲸鱼娘完成了这一步' : '大肥鱼绘图助手';
  if (pose === 'portrait') return <img className={`whale-character portrait ${className}`} src="/brand/characters/portrait.png" alt={decorative ? '' : label} decoding="async" draggable={false} />;
  return <span className={`whale-character sprite ${pose} ${className}`} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative ? true : undefined} />;
}
