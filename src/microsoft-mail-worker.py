"""Read only recent OpenAI messages; credentials arrive over stdin, never argv."""
import email
import email.policy
import email.utils
import imaplib
import json
import re
import ssl
import sys
import time
from datetime import datetime, timedelta, timezone


def message_record(raw, metadata, folder, uid):
    message = email.message_from_bytes(raw, policy=email.policy.default)
    sender = email.utils.parseaddr(str(message.get("From", "")))[1].lower()
    domain = sender.rsplit("@", 1)[-1]
    if domain != "openai.com" and not domain.endswith(".openai.com"):
        return None
    parts = []
    for part in message.walk():
        if part.get_content_type() not in ("text/plain", "text/html") or part.get_content_disposition() == "attachment":
            continue
        try:
            content = part.get_content()
            if isinstance(content, str):
                parts.append(content[:65_536])
        except (LookupError, ValueError):
            continue
    received = imaplib.Internaldate2tuple(metadata)
    if received is None:
        return None  # Without a server timestamp, an old message must not satisfy a new request.
    return {
        "id": folder + ":" + uid.decode("ascii"),
        "received_at": int(time.mktime(received) * 1000),
        "subject": str(message.get("Subject", "")),
        "body": "\n".join(parts)[:65_536],
    }


def read_messages(address, access_token, imap_factory=imaplib.IMAP4_SSL):
    with imap_factory("outlook.office365.com", 993, ssl_context=ssl.create_default_context(), timeout=15) as mailbox:
        auth = f"user={address}\x01auth=Bearer {access_token}\x01\x01".encode("utf-8")
        mailbox.authenticate("XOAUTH2", lambda challenge: auth if not challenge else b"")
        folders = ["INBOX"]
        status, entries = mailbox.list()
        if status == "OK":
            for entry in entries or []:
                if not isinstance(entry, bytes):
                    continue
                match = re.match(rb'\((.*?)\)\s+(?:"[^"]*"|NIL)\s+(.+)$', entry)
                if match and b"\\junk" in match[1].lower():
                    folders.append(match[2].decode("ascii"))
                    break
        if len(folders) == 1:
            folders.append("Junk")
        since = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%d-%b-%Y")
        messages = []
        for folder in folders:
            status, _ = mailbox.select(folder, readonly=True)
            if status != "OK":
                if folder == "INBOX":
                    raise imaplib.IMAP4.error("Inbox unavailable")
                continue
            status, identifiers = mailbox.uid("SEARCH", None, "SINCE", since, "FROM", '"openai.com"')
            if status != "OK":
                raise imaplib.IMAP4.error("Search failed")
            for uid in (identifiers[0] or b"").split()[-10:]:
                status, items = mailbox.uid("FETCH", uid, "(INTERNALDATE BODY.PEEK[]<0.131072>)")
                if status != "OK":
                    raise imaplib.IMAP4.error("Fetch failed")
                for item in items or []:
                    if isinstance(item, tuple) and len(item) == 2 and isinstance(item[1], bytes):
                        record = message_record(item[1], item[0], folder, uid)
                        if record:
                            messages.append(record)
        return messages


def main():
    try:
        config = json.loads(sys.stdin.read(32_768))
        address = config["email"]
        token = config["accessToken"]
        if not isinstance(address, str) or not re.fullmatch(r"[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+", address):
            raise ValueError("Invalid email")
        if not isinstance(token, str) or not token or re.search(r"[\s\x00-\x1f]", token):
            raise ValueError("Invalid token")
        print(json.dumps({"messages": read_messages(address, token)}, ensure_ascii=True))
    except imaplib.IMAP4.error as error:
        # IMAP protocol errors do not prove OAuth authorization has expired.
        text = str(error).lower()
        message = (
            "微软邮箱 IMAP 已认证但未连接；可能未启用 IMAP 或邮箱服务暂时异常，可稍后重试或手动收码"
            if "authenticated but not connected" in text
            else "微软邮箱 IMAP 请求失败；可能是邮箱服务或权限问题，可稍后重试或手动收码"
        )
        print(json.dumps({"error": message, "code": "MICROSOFT_IMAP_ERROR", "retryable": True}))
        return 1
    except (OSError, TimeoutError):
        print(json.dumps({"error": "微软邮箱 IMAP 网络连接失败或超时", "retryable": True}))
        return 1
    except Exception:
        print(json.dumps({"error": "微软邮箱读取失败，请检查输入格式", "retryable": False}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
