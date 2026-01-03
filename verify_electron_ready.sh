#!/bin/bash
# Verification script to check if the Electron app is ready to run

set -e

echo "Physics Data Viewer - Electron App Readiness Check"
echo "=================================================="
echo ""

# Check Python version
echo "✓ Checking Python version..."
python3 --version || { echo "❌ Python 3 not found"; exit 1; }

# Check Node.js version
echo "✓ Checking Node.js version..."
node --version || { echo "❌ Node.js not found"; exit 1; }
npm --version || { echo "❌ npm not found"; exit 1; }

# Check if we're in the right directory
if [ ! -f "pyproject.toml" ]; then
    echo "❌ Must be run from project root directory"
    exit 1
fi

# Check Python dependencies
echo "✓ Checking Python dependencies..."
PYTHONPATH=src python3 -c "from platform.server.app import app" || {
    echo "❌ Python backend not installed"
    echo "   Run: pip install -e .[test]"
    exit 1
}

# Check Electron dependencies
echo "✓ Checking Electron dependencies..."
if [ ! -d "electron/node_modules" ]; then
    echo "⚠️  Electron dependencies not installed"
    echo "   Run: cd electron && npm install"
    exit 1
fi

# Check if frontend is built
echo "✓ Checking frontend build..."
if [ ! -f "electron/dist/bundle.js" ]; then
    echo "⚠️  Frontend not built yet (will build automatically on first npm start)"
fi

# Run tests
echo "✓ Running tests..."
python3 -m pytest tests/unit/test_autocomplete.py -q || {
    echo "❌ Tests failed"
    exit 1
}

echo ""
echo "=================================================="
echo "✅ ALL CHECKS PASSED!"
echo ""
echo "The Electron app is ready to run. Follow these steps:"
echo ""
echo "Terminal 1 - Start Backend:"
echo "  PYTHONPATH=src uvicorn platform.server.app:app --host 127.0.0.1 --port 8000"
echo ""
echo "Terminal 2 - Start Electron:"
echo "  cd electron"
echo "  npm install  # First time only"
echo "  npm start    # Builds automatically and launches"
echo ""
echo "Note: First npm start may take 10-30 seconds to build."
echo "See QUICKSTART.md for detailed instructions."
echo "=================================================="
