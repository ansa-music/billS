#!/usr/bin/env python3
"""qmp.py — one QMP command to a running QEMU (helper of vm-test.sh; standard library only).

    qmp.py <socket> <command> [json-arguments]
    qmp.py /tmp/vm/qmp.sock screendump '{"filename": "/tmp/vm/a.png", "format": "png"}'
    qmp.py /tmp/vm/qmp.sock system_powerdown

Prints the "return" value as JSON; exit code 1 on a QMP error, 2 when QEMU is not reachable.
"""
import json
import socket
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    path, command = sys.argv[1], sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(15)
        sock.connect(path)
    except OSError as err:
        print(f"qmp: {path}: {err}", file=sys.stderr)
        return 2
    stream = sock.makefile("rwb", buffering=0)

    def read_reply():
        # Skip asynchronous events until a reply ("return"/"error") or the greeting arrives.
        while True:
            line = stream.readline()
            if not line:
                raise ConnectionError("QEMU closed the QMP connection")
            msg = json.loads(line)
            if "return" in msg or "error" in msg or "QMP" in msg:
                return msg

    def send(cmd, arguments=None):
        req = {"execute": cmd}
        if arguments is not None:
            req["arguments"] = arguments
        stream.write((json.dumps(req) + "\n").encode())
        return read_reply()

    try:
        read_reply()  # greeting
        send("qmp_capabilities")
        reply = send(command, args)
    except (OSError, ValueError, ConnectionError) as err:
        print(f"qmp: {command}: {err}", file=sys.stderr)
        return 2
    finally:
        sock.close()
    if "error" in reply:
        print(f"qmp: {command}: {reply['error'].get('desc', reply['error'])}", file=sys.stderr)
        return 1
    print(json.dumps(reply.get("return", {}), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
