# 实现计划 · 课前演讲排班

- [ ] 0. grill-me 需求确认 + 规格文档（本文件）
- [ ] 1. T1 去光：tilt-card wxss 删描边/柔光 + 门禁反向改（check-tilt-card / check-dark-ui-fixes）+ 变异自证
- [ ] 2. T2 值日卡去按压：home/index.wxml hero 去掉 hover-class/data-pressable，onHero 逻辑不动 + 门禁
- [ ] 3. T3 后端数据层：新建 `speech` / `speech_cursor` / `speech_publish` 表（migration sql），独立游标字段
- [ ] 4. T3 云函数 schedule 新增 action：generate/listWeek/reassign/clear/publish/unpublish/getSettings/setSettings，独立游标 + pickBySeq 内核，挂 requireScheduleAuth + gateDemoWrite
- [ ] 5. T3 前端值日页加"课前演讲"分栏：设置(人数/起始周x时段/起始学号)、生成、换人、清空、发布/撤回、周次切换、学生视角展示
- [ ] 6. T3 门禁：新建 check-speech-schedule.js（轮转/组别/起始/发布/权限/游标独立），变异自证
- [ ] 7. 闭环验证 + 发版 1.0.8.48：node --check→normalize-eol→wcsc→src-bytes→release-docs→全量门禁→commit/push→tag→云函数部署→真上传→HANDOFF/日志

## 关键不变量（防漂移）
- 选修课不纳入课表判断
- 演讲人组 = 课次 group_tag；全体课从全班公共游标选
- 每人一个进度游标，A/B 各自独立、末尾回绕、跨周永久续排
- 起始设置只用一次（首场落点 + 首次学号下限）
- 换人完全自由、不回退游标
- 草稿→发布给全班才可见，权限 = 超管 OR 生活委员
