const { plugin, SchemaError, ValidationError } = require('varlock/plugin-lib');

// counts module executions, so tests can prove that shape mode never runs this file
globalThis.__varlockManifestTestPluginRuns = (globalThis.__varlockManifestTestPluginRuns || 0) + 1;

plugin.icon = 'mdi:puzzle';
plugin.bundledIcons = { 'mdi:puzzle': '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z"/></svg>' };
plugin.standardVars = {
  initDecorator: '@initManifestTest',
  params: { token: { key: ['MANIFEST_TEST_TOKEN'], dataType: 'manifestTestToken' } },
};

plugin.registerRootDecorator({
  name: 'initManifestTest',
  description: 'Initialize the manifest test plugin',
  isFunction: true,
  process(argsVal) {
    if (!argsVal.objArgs?.token) throw new SchemaError('token is required');
    return {};
  },
  async execute() {},
});

plugin.registerItemDecorator({
  name: 'manifestTag',
  incompatibleWith: ['public'],
  deprecated: 'use @sensitive instead',
});

plugin.registerDataType({
  name: 'manifestTestToken',
  typeDescription: 'Token for the manifest test service',
  sensitive: true,
  internal: true,
  docs: [{ description: 'Manifest test docs', url: 'https://example.com/docs' }],
  validationRules: [
    { startsWith: 'mt_', message: 'must start with mt_', tip: 'tokens look like mt_abc123' },
    { minLength: 6, message: 'too short' },
  ],
  validationSamples: ['mt_abc123', 'mt_ab', 'nope'],
  validate(val) {
    if (!val.startsWith('mt_')) throw new ValidationError('must start with mt_', { tip: 'tokens look like mt_abc123' });
    if (val.length < 6) throw new ValidationError('too short');
  },
});

// takes settings, so it is registered as a function of them
plugin.registerDataType((settings) => ({
  name: 'manifestTestPort',
  icon: 'mdi:ethernet',
  coercedType: 'int',
  coerce: (val) => parseInt(val, 10),
  validationRules: [{ custom: 'at most the max setting' }],
  validate: (val) => (settings?.max === undefined || val <= settings.max),
}));

// part of its validation can only run in code
plugin.registerDataType({
  name: 'manifestTestJson',
  validationRules: [
    { startsWith: '{', message: 'must be a JSON object' },
    { custom: 'parses as JSON', message: 'must be valid JSON' },
  ],
  validationSamples: ['{"a":1}', '{nope', '[1]'],
  validate(val) {
    if (!val.startsWith('{')) throw new ValidationError('must be a JSON object');
    try {
      JSON.parse(val);
    } catch {
      throw new ValidationError('must be valid JSON');
    }
  },
});

plugin.registerResolverFunction({
  name: 'manifestFetch',
  label: 'Fetch a value from the manifest test service',
  description: 'Reads one secret by name',
  inferredType: 'manifestTestToken',
  impliesSensitive: true,
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 2 },
  process() {
    if (!this.arrArgs[0].isStatic) throw new SchemaError('expected a static name');
  },
  async resolve() {
    return 'mt_secret';
  },
});

plugin.registerCodeGenerator({
  decoratorName: 'generateManifestTestFile',
  knownOptions: ['flavor'],
  generate: () => 'generated',
});

plugin.registerProxyTransformScheme({
  scheme: 'manifest-test-sign',
  options: {
    keyId: { required: true, type: 'string', itemRole: 'wire' },
    region: { type: 'enum', enumValues: ['eu', 'us'] },
  },
  apply: () => ({ setHeaders: { 'x-signed': 'yes' } }),
});
