const http = require("http");
const { send } = require("./src/http");
const { handle } = require("./src/router");

const PORT = Number(process.env.PORT || 3021);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const body = { error: error.message || "服务器错误" };
    if (error.details) body.details = error.details;
    send(res, error.status || 500, body);
  });
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
