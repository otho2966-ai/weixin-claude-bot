/**
 * Standalone login script: run `npm run login` to authenticate via QR code.
 * Saves credentials to ~/.weixin-claude-bot/credentials.json
 */
import { loginWithQR } from "./ilink/auth.js";
import { saveCredentials } from "./store.js";

async function main() {
  console.log("=== 微信 ClawBot 登录 ===\n");
  const result = await loginWithQR();
  saveCredentials(result);
  console.log(`\n账号 ID: ${result.accountId}`);
  console.log(`Base URL: ${result.baseUrl}`);
  if (result.userId) console.log(`用户 ID: ${result.userId}`);
  console.log("\n登录完成！现在可以运行 npm start 启动 Bot。");
}

main().catch((err) => {
  console.error("登录失败:", err.message);
  process.exit(1);
});
