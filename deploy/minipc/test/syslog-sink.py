#!/usr/bin/env python3
"""syslog-sink.py — writes UDP syslog messages to a file (helper of vm-test.sh).

    syslog-sink.py <port> <file>

The test image (build-iso.sh --serial) boots the Debian installer with log_host=10.0.2.2: QEMU user
networking delivers those datagrams to 127.0.0.1:<port> on the host, so every installer message,
including each debconf question (DEBCONF_DEBUG=5), lands in <file> while the install runs.
"""
import socket
import sys


def main() -> int:
    port, path = int(sys.argv[1]), sys.argv[2]
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", port))
    with open(path, "ab", buffering=0) as out:
        while True:
            data, _ = sock.recvfrom(65535)
            out.write(data.rstrip(b"\0\r\n") + b"\n")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
