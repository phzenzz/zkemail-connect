/**
 * [已退役] to_addr 改为静态 spec：regex-specs/to_addr.json 与
 * src/regexes/to_addr_regex.circom 均 checked in，relay 地址不再编译进
 * 电路 DFA（电路只约束 To addr-spec 的 Poseidon == relayerEmailHash public
 * input，地址绑定移到链上 escrow 的 relayer_email_hash 校验），因此本脚本
 * 没有任何产物可生成。文件保留、main() 仅打印一行，避免 rebuild 链断掉。
 *
 * Usage: cd circuits && npx tsx scripts/gen-regexes.ts
 */
function main() {
  console.log("[gen-regexes] to_addr 为静态 spec，无需生成");
}

main();
