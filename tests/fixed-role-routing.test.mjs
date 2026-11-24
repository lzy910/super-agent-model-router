import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanFromRoutes } from '../.dsh-plugin/shared/harness-plan.mjs'
import { collaborationStage } from '../.dsh-plugin/shared/router.mjs'
import { applyManualPackagePlan } from '../.dsh-plugin/shared/manual-plan.mjs'
import { executeAssignmentPlan, rerunAssignmentPackage } from '../.dsh-plugin/shared/task-executors.mjs'
import { buildRunRecord } from '../.dsh-plugin/shared/run-ledger.mjs'

const routes = [
  { provider: 'deepseek', model: 'deepseek-chat', execution: 'api', quality: 0.5, pricing: { input: 1, output: 2 } },
  { provider: 'deepseek', model: 'deepseek-reasoner', execution: 'api', quality: 0.9 },
  { provider: 'dashscope', model: 'qwen-plus', execution: 'api', quality: 0.5, pricing: { input: 1, output: 2 } },
  { provider: 'dashscope', model: 'qwen-turbo', execution: 'api', quality: 0.9 },
  { provider: 'other', model: 'strong-model', execution: 'api', quality: 1, pricing: { input: 0, output: 0 } },
]
const expectedModels = ['deepseek-chat', 'deepseek-chat', 'qwen-plus', 'qwen-plus']

test('fixed roles keep exactly two models across task complexity, route order, presets and budgets', () => {
  for (const task of ['你好', '实现登录并验证权限', '1. 开发接口\n2. 实现网页\n3. 编写测试\n4. 部署服务\n5. 整理文档']) {
    for (const preset of ['economy', 'balanced', 'quality']) {
      for (const mode of ['single', 'team']) {
        const plan = createPlanFromRoutes(task, [...routes].reverse(), { mode, preset, budgetUsd: 0.000001 })
        assert.deepEqual(plan.subtasks.map(item => item.name), ['架构', '开发', '测试', '交付'])
        assert.deepEqual(plan.team.workPackages.map(item => item.recommendedModel), expectedModels)
        assert.equal(plan.optimization.distinctRoutes, 2)
        assert.equal(plan.synthesizer.model, 'qwen-plus')
        assert.equal(collaborationStage(plan, 4).name, '交付')
        assert.equal(collaborationStage(plan, 5), null)
        assert.deepEqual(plan.team.workPackages[3].dependsOn, ['analysis', 'execution', 'verification'])
        assert.throws(() => applyManualPackagePlan(plan, {}, routes), /固定四角色/)
      }
    }
  }
})

test('missing required model is a configuration error and direct calls remain available', () => {
  assert.throws(() => createPlanFromRoutes('开发服务', routes.filter(item => !item.model.startsWith('qwen'))), /缺少 Qwen/)
  assert.throws(() => createPlanFromRoutes('开发服务', routes.filter(item => !item.model.startsWith('deepseek'))), /缺少 DeepSeek/)
  const plan = createPlanFromRoutes('设计、开发并测试服务', routes, { mode: 'direct', directProvider: 'other', directModel: 'strong-model' })
  assert.equal(plan.routingBypassed, true)
  assert.equal(plan.fixedRolePolicy, null)
  assert.equal(plan.subtasks.length, 1)
  assert.equal(plan.selected.model, 'strong-model')
})

test('execution passes role results downstream and persists fixed routes for retries', async () => {
  const task = '开发一个登录服务'
  const plan = createPlanFromRoutes(task, routes)
  const calls = []
  const execution = await executeAssignmentPlan({ plan, task, routes, apiFallback: async ({ route, task: prompt }) => {
    calls.push({ model: route.model, prompt })
    return { ok: true, answer: `工作结果-${calls.length}`, usage: { inputTokens: 10, outputTokens: 10 } }
  } })
  assert.equal(execution.status, 'completed')
  assert.deepEqual(calls.map(item => item.model), expectedModels)
  assert.match(calls[1].prompt, /工作结果-1/)
  assert.match(calls[2].prompt, /工作结果-2/)
  assert.match(calls[3].prompt, /工作结果-3/)
  assert.match(calls[2].prompt, /边界与回归风险/)
  const record = buildRunRecord({ id: 'fixed-test', createdAt: Date.now(), task, plan, execution })
  assert.equal(record.fixedRolePolicy, plan.fixedRolePolicy)
  assert.deepEqual(record.packages.map(item => item.fixedRoute.model), expectedModels)
  await assert.rejects(() => rerunAssignmentPackage({ task, packages: record.packages, previous: execution.packages,
    packageId: 'verification', routes, override: { provider: 'other', model: 'strong-model' },
    apiFallback: async () => assert.fail('reassignment must not invoke a model'),
  }), /固定四角色/)
})

test('failed development blocks testing and delivery; retry resumes with the fixed models', async () => {
  const task = '实现一个接口'
  const plan = createPlanFromRoutes(task, routes)
  const calls = []
  const execution = await executeAssignmentPlan({ plan, task, routes, apiFallback: async ({ route }) => {
    calls.push(route.model)
    return calls.length === 2 ? { ok: false, error: 'development failed' } : { ok: true, answer: '架构方案' }
  } })
  assert.deepEqual(calls, ['deepseek-chat', 'deepseek-chat'])
  assert.equal(execution.packages[2].blocked, true)
  assert.equal(execution.packages[3].blocked, true)
  const record = buildRunRecord({ id: 'failed-test', createdAt: Date.now(), task, plan, execution })
  calls.length = 0
  const retry = await rerunAssignmentPackage({ task, packages: record.packages, previous: execution.packages,
    packageId: 'execution', routes, apiFallback: async ({ route, task: prompt }) => {
      calls.push(route.model)
      assert.match(prompt, /架构方案/)
      return { ok: true, answer: '重试成功' }
    },
  })
  assert.equal(retry.status, 'completed')
  assert.deepEqual(calls, ['deepseek-chat', 'qwen-plus', 'qwen-plus'])
})
