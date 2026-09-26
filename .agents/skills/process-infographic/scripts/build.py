"""Collect current Career-Ops/Career Docs data and render into a NEW private directory."""
import argparse
import json
from pathlib import Path
import subprocess
from render import render


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('career-ops', 'career-docs', 'interviews-file', 'register-json', 'events', 'font'):
        parser.add_argument('--' + name)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--variant', choices=['both', 'full', 'anonymous'], default='both')
    args = parser.parse_args()
    command = ['node', str(Path(__file__).with_name('collect.mjs')), '--out', str(args.out)]
    for name in ('career-ops', 'career-docs', 'interviews-file', 'register-json', 'events'):
        value = getattr(args, name.replace('-', '_'))
        if value:
            command += ['--' + name, value]
    subprocess.run(command, check=True)
    for name in ('applications', 'interviews'):
        chart = args.out / (name + '-chart.json')
        if chart.exists():
            render(json.loads(chart.read_text()), args.out / name, args.variant, args.font)


if __name__ == '__main__':
    main()
