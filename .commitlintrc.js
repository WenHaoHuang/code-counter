module.exports = Object.assign({}, require('changelog-sn/lib/lint'), {
  rules: {
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
    'scope-empty': [2, 'never'],
    'type-enum': [2, 'always', ['新功能', '修复', '优化', '重构', '文档', 'test', 'chore', 'revert', 'WIP', 'build', 'release']]
  }
})
