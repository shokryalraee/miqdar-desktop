#!/usr/bin/env python3
"""Generates build/icon.ico + icon.icns + icon-512.png from build/icon.png (1024x1024 master). Needs Pillow. Run: npm run icons"""
import os
from PIL import Image
B = os.path.join(os.path.dirname(__file__), '..', 'build')
m = Image.open(os.path.join(B, 'icon.png')).convert('RGBA')
assert m.size == (1024, 1024), m.size
m.resize((512, 512), Image.LANCZOS).save(os.path.join(B, 'icon-512.png'))
m.save(os.path.join(B, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
m.save(os.path.join(B, 'icon.icns'), sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
print('ok')
