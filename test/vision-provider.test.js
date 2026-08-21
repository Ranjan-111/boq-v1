const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVisionProvider, classifyProviderError, VisionAuthError, VisionUnavailableError, PREFERENCE_CHAIN } = require('../src/vision/provider');

function stubFetch(handlers) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    // a generate URL also contains "/models", so route it to the generate handler first
    const isGenerate = String(url).includes(':generateContent');
    const eligible = handlers.filter(([pattern]) => (pattern.includes(':generateContent')) === isGenerate);
    for (const [pattern, respond] of eligible) {
      if (String(url).includes(pattern)) return respond({ url: String(url), options });
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
  };
  return { fetch, calls };
}
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const modelList = (names) => jsonResponse(200, { models: names.map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) });

test('the API key travels in a header, never in the URL', async () => {
  const { fetch, calls } = stubFetch([
    ['/models', () => modelList(['vision-pro', 'vision-lite'])],
    [':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'SOFA' }] } }] })]
  ]);
  const provider = createVisionProvider({ apiKey: 'secret-key-value', fetch });
  await provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(!call.url.includes('secret-key-value'), `key leaked into a URL: ${call.url}`);
    assert.ok(!call.url.includes('key='), `key passed as a query parameter: ${call.url}`);
    const headerValues = Object.values(call.options.headers || {}).join(' ');
    assert.ok(headerValues.includes('secret-key-value'), 'the key is sent as a header');
  }
});

test('models are discovered from the provider, not hardcoded', async () => {
  const { fetch, calls } = stubFetch([
    ['/models', () => modelList(['some-future-model', 'another-model'])],
    [':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'BED' }] } }] })]
  ]);
  const provider = createVisionProvider({ apiKey: 'k', fetch });
  const result = await provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.equal(result.label, 'BED');
  assert.ok(calls.some((call) => call.url.includes('/models') && !call.url.includes(':generate')), 'the list endpoint was consulted');
  assert.ok(calls.some((call) => call.url.includes('some-future-model')), 'a model name it had never heard of was used');
  assert.equal(result.model, 'some-future-model');
});

test('only models advertising the generate call are considered', async () => {
  const { fetch } = stubFetch([
    ['/models', () => jsonResponse(200, { models: [
      { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/can-generate', supportedGenerationMethods: ['generateContent'] }
    ] })],
    [':generateContent', ({ url }) => url.includes('can-generate')
      ? jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'WC' }] } }] })
      : jsonResponse(400, { error: { message: 'unsupported' } })]
  ]);
  const provider = createVisionProvider({ apiKey: 'k', fetch });
  const result = await provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.equal(result.model, 'can-generate');
});

test('a model-not-found error advances the chain', async () => {
  const attempted = [];
  const { fetch } = stubFetch([
    ['/models', () => modelList(['retired-model', 'working-model'])],
    [':generateContent', ({ url }) => {
      const model = url.match(/models\/([^:]+):/)[1];
      attempted.push(model);
      if (model === 'retired-model') return jsonResponse(404, { error: { message: 'models/retired-model is not found for API version v1beta' } });
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'TABLE' }] } }] });
    }]
  ]);
  const provider = createVisionProvider({ apiKey: 'k', fetch });
  const result = await provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.deepEqual(attempted, ['retired-model', 'working-model'], 'it moved on rather than giving up');
  assert.equal(result.label, 'TABLE');
});

test('an auth failure surfaces immediately and is never masked by a retry loop', async () => {
  const attempted = [];
  const { fetch } = stubFetch([
    ['/models', () => modelList(['model-a', 'model-b', 'model-c'])],
    [':generateContent', ({ url }) => {
      attempted.push(url.match(/models\/([^:]+):/)[1]);
      return jsonResponse(403, { error: { message: 'API key not valid' } });
    }]
  ]);
  const provider = createVisionProvider({ apiKey: 'bad', fetch });
  await assert.rejects(() => provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' }), VisionAuthError);
  assert.equal(attempted.length, 1, `an auth failure must not walk the chain, tried ${attempted.length}`);
});

test('error classification distinguishes a retired model from a rejected key', () => {
  assert.equal(classifyProviderError(404, 'models/x is not found').kind, 'model_not_found');
  assert.equal(classifyProviderError(400, 'model x is not supported for generateContent').kind, 'model_not_found');
  assert.equal(classifyProviderError(401, 'unauthorized').kind, 'auth');
  assert.equal(classifyProviderError(403, 'API key not valid').kind, 'auth');
  assert.equal(classifyProviderError(429, 'quota').kind, 'unavailable');
  assert.equal(classifyProviderError(500, 'internal').kind, 'unavailable');
});

test('when every discovered model fails as not-found the provider reports unavailable, not a label', async () => {
  const { fetch } = stubFetch([
    ['/models', () => modelList(['gone-1', 'gone-2'])],
    [':generateContent', () => jsonResponse(404, { error: { message: 'is not found' } })]
  ]);
  const provider = createVisionProvider({ apiKey: 'k', fetch });
  await assert.rejects(() => provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' }), VisionUnavailableError);
});

test('a preference chain exists as a fallback when discovery returns nothing usable', async () => {
  assert.ok(Array.isArray(PREFERENCE_CHAIN) && PREFERENCE_CHAIN.length > 0);
  const { fetch, calls } = stubFetch([
    ['/models', () => jsonResponse(200, { models: [] })],
    [':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'CHAIR' }] } }] })]
  ]);
  const provider = createVisionProvider({ apiKey: 'k', fetch });
  const result = await provider.classify({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.ok(PREFERENCE_CHAIN.includes(result.model), 'it fell back to the preference chain');
  assert.ok(calls.some((call) => call.url.includes('/models')));
});
