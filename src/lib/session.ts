/** 把系统 token 写进目标页的同源 localStorage，供录制/回放时页面自身鉴权使用。 */
export function injectSystemToken(doc: Document, raw: string): void {
  const clean = raw.trim().replace(/^bearer /i, "");
  if (!clean) return;
  try {
    const storage = doc.defaultView?.localStorage;
    if (!storage) return;
    storage.setItem("token", clean);
    storage.setItem("access_token", clean);
    storage.setItem("Authorization", clean);
    try {
      const user = JSON.parse(storage.getItem("UserInfo") ?? "{}") as Record<string, unknown>;
      storage.setItem("UserInfo", JSON.stringify({ ...user, token: clean }));
    } catch {
      storage.setItem("UserInfo", JSON.stringify({ token: clean }));
    }
  } catch {
    // 目标页跨域时 storage 不可写，交给后续同源校验报错。
  }
}
