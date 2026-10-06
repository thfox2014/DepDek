"""Synthetic loopback provider only. No real model, filesystem, or API keys."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if self.path != "/v1/chat/completions" or not 0 < length < 20000:
            self.send_error(400)
            return
        data = json.loads(self.rfile.read(length))
        if (self.headers.get("Authorization") != "Bearer synthetic-linux-provider-key"
                or data != {"model": "synthetic-linux-model", "messages": [
                    {"role": "user", "content": "仅分析合成空调维修材料"}],
                    "stream": False, "max_tokens": 128}):
            self.send_error(400)
            return
        body = json.dumps({"choices": [{"message": {
            "content": "合成资料已核对：forms@support.example.invalid"}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 8}},
            ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", 18080), Provider).serve_forever()
