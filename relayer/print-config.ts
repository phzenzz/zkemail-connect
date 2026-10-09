// 脱敏打印当前生效配置（npm run relayer:print-config / :print-config:local），供人工核对。
import { loadConfig, describeConfig } from "./config";

console.log(describeConfig(loadConfig()));
