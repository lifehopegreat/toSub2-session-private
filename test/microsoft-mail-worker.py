import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("worker", Path(__file__).resolve().parents[1] / "src" / "microsoft-mail-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
raw = b"From: OpenAI <noreply@tm.openai.com>\r\nSubject: =?utf-8?b?T3BlbkFJIHZlcmlmaWNhdGlvbiBjb2Rl?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour security code is 123456"
metadata = b'1 (UID 1 INTERNALDATE "13-Oct-2026 09:00:00 +0800" BODY[] {100})'
assert worker.message_record(raw, metadata, "INBOX", b"1")["body"] == "Your security code is 123456"
assert worker.message_record(raw.replace(b"tm.openai.com", b"openai.com.evil.example"), metadata, "INBOX", b"1") is None
assert worker.message_record(raw, b"missing internal date", "INBOX", b"1") is None


class FakeImap:
    selected = []

    def __init__(self, host, port, ssl_context, timeout):
        assert host == "outlook.office365.com" and port == 993
        assert ssl_context.check_hostname and timeout == 15

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def authenticate(self, mechanism, callback):
        assert mechanism == "XOAUTH2"
        assert callback(b"") == b"user=test@outlook.com\x01auth=Bearer synthetic-access\x01\x01"
        assert callback(b"failure challenge") == b""

    def list(self):
        return "OK", [b'(\\Junk) "/" "Junk Email"']

    def select(self, folder, readonly):
        assert readonly is True
        self.selected.append(folder)
        return "OK", [b"1"]

    def uid(self, command, *args):
        if command == "SEARCH":
            assert "FROM" in args and '"openai.com"' in args
            return "OK", [b"1"]
        assert command == "FETCH"
        assert "BODY.PEEK" in args[1] and "131072" in args[1]
        return "OK", [(metadata, raw), b")"]


messages = worker.read_messages("test@outlook.com", "synthetic-access", FakeImap)
assert len(messages) == 2
assert FakeImap.selected == ["INBOX", '"Junk Email"']
assert messages[0]["id"] != messages[1]["id"]
