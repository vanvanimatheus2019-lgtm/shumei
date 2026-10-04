/* 旧工程附带的核验摘要与本次可运行检查分开记录。
 * 原摘要所指的像素核验、jsdom 冒烟及审计工具没有随包提供；本次未复跑这些检查。
 * 顶层为空，避免把旧 117/117 或像素误差继续展示为当前已验证结果。
 */
window.EVIDENCE = {
  caliber: null, max_d_ndvi: null, max_d_fvc_pp: null,
  tol_ndvi: null, tol_fvc_pp: null, years: null, pass: null,
  source: '历史摘要，原始核验产物待补',
  smokePass: null, smokeTotal: null, auditL2: null, auditL3: null,
  status: '历史记录未复跑',
  historical: {
    caliber: 'PNG', max_d_ndvi: 0.0010113800057355016,
    max_d_fvc_pp: 0.2217392759113821, tol_ndvi: 0.02, tol_fvc_pp: 3,
    years: 40, smokePass: 117, smokeTotal: 117, auditL2: 0, auditL3: 0,
    reproduced: false,
    source: '旧工程 evidence.js；所引原始报告未随包提供',
  },
  current: {
    commands: ['node --test tests/data.test.cjs', 'node tools/audit_numbers.cjs'],
    report: 'docs/数字审计结果.json',
    scope: '随附数组、数字计算及展示约束；不验证原始遥感观测或治理归因',
  },
};
