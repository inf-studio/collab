# 证据包（来自 ses_e0e3…Fm8Z，thread t_mwn1z6bg_6yd7）

链路：A `ses_edc3c78edffeoH5pvKHZie4Mw5`(issues-wt) → B `ses_e0e3d0ffaffeJJdK2CCKLXFm8Z`(mojoy-studio) → C `ses_e4c03493fffeY5BT7ed1WwQstQ`(mojoy-studio)

## 交接台账
- `b_b95c6917a0a1d483` peer A→B，DONE
- `b_f68914b8eaadd14a` local B→C（thread `t_mwmzs46q_hb40`），DONE
- `b_9353072aa6eb5baf` local B→C（thread `t_mwn1fvb4_tfqc`），ACCEPT→BLOCKED
- `b_761eede426ca6372` 历史单，acked 90min 未闭环

## 对接人缺失（第 1 条）
B→C 记录 `from.sid`=B；A 只在正文出现过一次。
后果：C BLOCKED → 无 A 的 sid → 回 B → B 转 A → A 在其它 thread 回「等你四组结论」→ B 再指路 = **4 跳**。
缓解实测：正文首行补「对接人 sid+location」后一次即通（msg_1f212e7d3001… / msg_1f212e7d60014…）。

## 跨 thread 重发（第 3 条）
同一句 BLOCKED 发 3 个 thread，per-thread dedupe 全放行：
- `t_mwmzdzhu_bluz` → msg_1f20f28b4001cNp0SN6WwKYCTe
- `t_mwmzyytb_b8g1` → msg_1f20f74a0001FiUU2tAKkJk9AN
- `t_mwn15sjw_pr7a` → msg_1f20fbd20001w0cM1CmQ4tqRdV
A 在三个 thread 各回了一次「等你四组结论」，没有一次落在它当时使用的 thread。

## 同一对会话 7 个 thread（第 2 条）
`t_mwmzdzhu_bluz` `t_mwmzyjum_bskr` `t_mwmzyytb_b8g1` `t_mwn0xufb_w1mk` `t_mwn15sjw_pr7a` `t_mwn1z6be_a6ek` `t_mwn1t1my_z2jn`

## collab_status 对消息 thread 报错（第 6 条，本轮新发现）
7 个 thread 里 6 个是 collab_send/reply 建立（无广播记录）→ 直接报错
`没有 thread … 对应的交接单`。我们自己在本会话也复现过同一条错误。

## BLOCKED 结构化（第 4 条实证）
最小判别：「连 watch 后改一次房态（room:state 与 room:order 共用 Pub/Sub）——无帧=整体断；有帧=listener 派发」
执行结果：`--state 6` → `[]`、`--state 0` → `[]`、两种写后仍零帧 → 根因从「room:order 不推」升级为「集群推送整体断」。

## 非 collab（仅记录）
- CLI 退出码矩阵（0/1/2/3）与握手 401/502 文案可直接当验收用例；
- `ws.close(1000)` 等 ack 导致进程挂 30s（`closeTimeout`），实测 30311ms → 410ms（100ms unref terminate）;
- 归档只 `git add` archive 副本、未暂存源删除 → HEAD 双份（已修 88477404b），建议归档模板加 `git status --short` 自检。
