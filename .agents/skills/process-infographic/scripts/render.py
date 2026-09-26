"""Deterministic process Sankey renderer. Python + Pillow; no network."""
import argparse
from collections import Counter
from html import escape
import json
import math
from pathlib import Path
import re
from PIL import Image, ImageDraw, ImageFont


def require(condition, message):
    if not condition:
        raise ValueError(message)


def prepare(data):
    nodes = {n['id']: n for n in data['nodes']}
    require(len(nodes) == len(data['nodes']), 'Duplicate node ID')
    require(data['records'] and nodes, 'Empty graph')
    require(isinstance(data.get('public_title'), str), 'public_title is required')
    seen, visits, edges = set(), Counter(), Counter()
    for record in data['records']:
        identity, path, weight = record['id'], record['path'], record.get('weight', 1)
        require(identity not in seen, 'Duplicate record ID')
        seen.add(identity)
        require(isinstance(record.get('sources'), list) and all(isinstance(s, str) and s.strip() for s in record['sources']) and record['sources'], 'Record needs sources')
        require(type(weight) is int and weight > 0, 'Weight must be a positive integer')
        require(len(path) >= 2 and len(set(path)) == len(path), 'Path needs at least two unique nodes')
        require(all(n in nodes for n in path), 'Unknown path node')
        visits.update({n: weight for n in path})
        edges.update({pair: weight for pair in zip(path, path[1:])})
    for key, node in nodes.items():
        require(visits[key] > 0, f'Unused node: {key}')
        require(isinstance(node.get('public_label'), str), f'public_label required: {key}')
        require(re.fullmatch(r'#[0-9a-fA-F]{6}', node['color']), 'Use #RRGGBB colors')
        require(node.get('placement', 'right') in ('right', 'above'), 'Invalid label placement')
        incoming = sum(v for (a, b), v in edges.items() if b == key)
        outgoing = sum(v for (a, b), v in edges.items() if a == key)
        require(incoming in (0, visits[key]) and outgoing in (0, visits[key]), f'Flow not conserved at {key}; add a waiting/exit node')
    for a, b in edges:
        require(nodes[b]['x'] > nodes[a]['x'] + 24, 'Edges must go left to right')
    return nodes, visits, edges


def render(data, out, variant='both', font=None):
    nodes, visits, edges = prepare(data)
    width, height = data['width'], data['height']
    require(type(width) is int and type(height) is int and 200 <= width <= 10000 and 200 <= height <= 10000 and width*height <= 20000000, 'Invalid canvas size')
    unit, size = data.get('unit', 24), data.get('font_size', 28)
    require(type(unit) in (int, float) and math.isfinite(unit) and unit > 0 and type(size) is int and 10 <= size <= 200, 'Invalid unit or font size')
    for n in nodes.values():
        require(all(type(n[k]) in (int, float) and math.isfinite(n[k]) for k in ('x', 'y')), 'Invalid coordinates')
        require(0 <= n['x'] <= width-24 and 0 <= n['y'] <= height-visits[n['id']]*unit, 'Node outside canvas')
    candidates = ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    font = font or next((p for p in candidates if Path(p).is_file()), None)
    require(font is not None, 'Supply --font with a suitable local font')
    variants = ['full', 'anonymous'] if variant == 'both' else [variant]
    require(all(v in ('full', 'anonymous') for v in variants), 'Unknown variant')
    rendered = []
    for version in variants:
        public = version == 'anonymous'
        prefix = 'public_' if public else ''
        image = Image.new('RGB', (width*2, height*2), 'white')
        draw = ImageDraw.Draw(image)
        svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="white"/>']
        labels = []

        def text(x, y, value, fontsize=size, color='#17242e'):
            require(isinstance(value, str), 'Labels must be strings')
            if not value:
                return
            labels.append(value)
            face = ImageFont.truetype(str(font), fontsize*2)
            bounds = draw.textbbox((x*2, y*2), value, font=face, anchor='lt')
            require(bounds[0] >= 0 and bounds[1] >= 0 and bounds[2] <= width*2 and bounds[3] <= height*2, f'Text outside canvas: {value}')
            draw.text((x*2, y*2), value, font=face, fill=color, anchor='lt')
            family = escape(face.getname()[0], quote=True)
            svg.append(f'<text x="{x}" y="{y}" dominant-baseline="text-before-edge" font-family="{family},sans-serif" font-size="{fontsize}" fill="{color}">{escape(value)}</text>')

        source_y, target_y = {}, {}
        for key, node in nodes.items():
            cursor = node['y']
            for pair in sorted((p for p in edges if p[0] == key), key=lambda p: (nodes[p[1]]['y'], p[1])):
                source_y[pair] = cursor
                cursor += edges[pair]*unit
            cursor = node['y']
            for pair in sorted((p for p in edges if p[1] == key), key=lambda p: (nodes[p[0]]['y'], p[0])):
                target_y[pair] = cursor
                cursor += edges[pair]*unit
        for (a, b), weight in edges.items():
            x1, x2 = nodes[a]['x']+24, nodes[b]['x']
            y1, y2 = source_y[a,b], target_y[a,b]
            h, dx, color = weight*unit, (x2-x1)*.48, nodes[b]['color']
            svg.append(f'<path d="M{x1},{y1} C{x1+dx},{y1} {x2-dx},{y2} {x2},{y2} L{x2},{y2+h} C{x2-dx},{y2+h} {x1+dx},{y1+h} {x1},{y1+h} Z" fill="{color}" fill-opacity=".34"/>')
            points = []
            for offset, steps in [(0, range(81)), (h, range(80,-1,-1))]:
                for i in steps:
                    t, u = i/80, 1-i/80
                    x = u**3*x1+3*u*u*t*(x1+dx)+3*u*t*t*(x2-dx)+t**3*x2
                    y = (u**3+3*u*u*t)*y1+(3*u*t*t+t**3)*y2+offset
                    points.append((x*2,y*2))
            rgb = tuple(round(int(color[i:i+2],16)*.34+255*.66) for i in (1,3,5))
            draw.polygon(points, fill=rgb)
        for key, node in nodes.items():
            x,y,h,color = node['x'],node['y'],visits[key]*unit,node['color']
            svg.append(f'<rect x="{x}" y="{y}" width="24" height="{h}" fill="{color}"/>')
            draw.rectangle((x*2,y*2,(x+24)*2,(y+h)*2), fill=color)
            details = node.get(prefix+'details', [])
            require(isinstance(details, list), 'Details must be a list of lines')
            tx,ty = (x,y-(len(details)+1)*(size+10)-12) if node.get('placement') == 'above' else (x+40,y-10)
            text(tx,ty,f"{visits[key]}  {node[prefix+'label']}")
            for i,line in enumerate(details):
                text(tx,ty+(i+1)*(size+10),line,size-3,'#647480')
        text(60,40,data[prefix+'title'],size+18)
        text(60,100,data.get(prefix+'subtitle',''),size-3,'#647480')
        footnotes = data.get(prefix+'footnotes', [])
        require(isinstance(footnotes, list), 'Footnotes must be a list')
        for i,line in enumerate(footnotes):
            text(60,height-30-(len(footnotes)-i)*(size+8),line,size-4,'#647480')
        if public:
            content = '\n'.join(labels).casefold()
            for term in data.get('sensitive_terms', []):
                require(isinstance(term, str) and term.strip(), 'Sensitive terms must be nonempty strings')
                require(term.casefold() not in content, f'Private term in public labels: {term}')
        svg.append('</svg>')
        rendered.append((version,'\n'.join(svg),image.resize((width,height),Image.Resampling.LANCZOS)))
    # Validate every requested variant before writing deliverables.
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for version,svg,image in rendered:
        (out/f'process-{version}.svg').write_text(svg,encoding='utf-8')
        image.save(out/f'process-{version}.png')
    return visits,edges


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('data', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--font')
    parser.add_argument('--variant', choices=['full','anonymous','both'], default='both')
    args = parser.parse_args()
    counts, _ = render(json.loads(args.data.read_text()),args.out,args.variant,args.font)
    print(f'Rendered {len(counts)} nodes ({args.variant}) to {args.out}')
