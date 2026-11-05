#!/usr/bin/env python3
"""A pseudo-terminal for the studio, without native Node modules.

Runs a command (default: the user's login shell) in a PTY. stdin -> the terminal, the terminal -> stdout.
File descriptor 3 carries control lines: "R <cols> <rows>" resizes the terminal. Exits with the child.
Works on Linux and macOS with the system python3.
"""
import fcntl, os, pty, select, signal, struct, sys, termios

def main():
    cols, rows = int(os.environ.get('COLS', '100')), int(os.environ.get('ROWS', '30'))
    cmd = sys.argv[1:] or [os.environ.get('SHELL', '/bin/bash'), '-l']
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        try:
            os.execvp(cmd[0], cmd)
        except Exception as e:
            sys.stderr.write(f'pty-bridge: {e}\n')
            os._exit(127)

    def resize(c, r):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        try:
            os.kill(pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    resize(cols, rows)
    try:
        os.fstat(3)
        ctl = 3
    except OSError:
        ctl = None
    ins = [0, fd] + ([ctl] if ctl is not None else [])
    buf = b''
    while True:
        try:
            r, _, _ = select.select(ins, [], [])
        except InterruptedError:
            continue
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                ins.remove(0)
            else:
                os.write(fd, data)
        if ctl is not None and ctl in r:
            data = os.read(ctl, 4096)
            if not data:
                ins.remove(ctl)
                ctl = None
                continue
            buf += data
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                p = line.decode().split()
                if len(p) == 3 and p[0] == 'R':
                    resize(int(p[1]), int(p[2]))
    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
    except ChildProcessError:
        sys.exit(0)

if __name__ == '__main__':
    main()
