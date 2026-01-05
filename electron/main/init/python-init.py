# Physics Data Viewer - Python kernel initialization
# This file is executed when a Python kernel starts. 

# --- Matplotlib backend setup ---
# The backend will be selected based on the capture mode: 
# - Native mode: Use QtAgg (or MacOSX on mac, TkAgg as fallback)
# - Capture mode: Use Agg (non-interactive) and return images via pdv_show()

# import os
# import sys
#
# def _setup_mpl_backend(capture_mode=False):
#     import matplotlib
#     if capture_mode:
#         matplotlib.use('Agg')
#     else:
#         # Try Qt backends first, then platform-specific, then Tk
#         for backend in ['QtAgg', 'Qt5Agg', 'MacOSX', 'TkAgg']:
#             try: 
#                 matplotlib.use(backend)
#                 break
#             except Exception:
#                 continue
#
# --- pdv_show() helper ---
# Captures the current matplotlib figure and returns it as base64 PNG/SVG
# for display in the Physics Data Viewer UI.
#
# def pdv_show(fmt='png'):
#     """Capture current figure and return as base64 for PDV UI."""
#     import matplotlib.pyplot as plt
#     import io
#     import base64
#     
#     buf = io.BytesIO()
#     plt.savefig(buf, format=fmt, bbox_inches='tight')
#     buf.seek(0)
#     data = base64.b64encode(buf.read()).decode('utf-8')
#     plt.close()
#     return {'mime': f'image/{fmt}', 'data': data}

# --- Standard namespace ---
# Common imports that are always available
# import numpy as np
# import pandas as pd
# import matplotlib.pyplot as plt

print("Physics Data Viewer Python kernel initialized.")
