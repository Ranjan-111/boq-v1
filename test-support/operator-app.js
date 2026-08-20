const { createServer } = require('../src/server');

async function startOperatorApp() {
  const server = createServer();
  const requests = [];
  server.on('request', (request) => requests.push(request.url));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

module.exports = { startOperatorApp };
