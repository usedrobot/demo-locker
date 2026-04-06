// stable color from a name
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = ["#4af", "#f6a", "#fa4", "#6c6", "#a6f", "#ff6", "#6cf", "#f86"];
  return palette[h % palette.length];
}
