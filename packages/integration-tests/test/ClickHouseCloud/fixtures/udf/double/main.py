import sys

# TabSeparated: one argument per line in, one result per line out.
for line in sys.stdin:
    print(int(line) * 2, flush=True)
