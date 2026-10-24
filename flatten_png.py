"""Flatten PNGs to 24-bit RGB (no alpha) in place, then report each file.

The Chrome Web Store expects 24-bit PNG without an alpha channel; Chrome's
screenshots carry one. Run over the generated listing assets.
"""
import sys

from PIL import Image


def main(paths):
    lines = []
    for p in paths:
        im = Image.open(p)
        if im.mode != 'RGB':
            bg = Image.new('RGB', im.size, (12, 15, 26))
            bg.paste(im, mask=im.split()[-1] if im.mode in ('RGBA', 'LA') else None)
            im = bg
            im.save(p, 'PNG', optimize=True)
        check = Image.open(p)
        import os
        lines.append('  %-38s %dx%d  %s  %.0f KB' % (
            os.path.basename(p), check.width, check.height, check.mode,
            os.path.getsize(p) / 1024))
    return lines


if __name__ == '__main__':
    out = main(sys.argv[1:])
    print('\nFinal assets (24-bit RGB PNG):')
    print('\n'.join(out))
