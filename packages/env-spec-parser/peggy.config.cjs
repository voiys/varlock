module.exports = {
  format: 'es',
  input: 'grammar.peggy',
  output: 'src/grammar.js',
  allowedStartRules: ['EnvSpecFile', 'EnvSpecNode'],
  ...process.env.PEGGY_TRACE && { trace: true },
};
