#!/usr/bin/env python3
"""
Example demonstrating the command input and autocomplete functionality.

This example starts the backend server and shows how autocomplete works
for Python code in a REPL-like environment.
"""

import asyncio
import httpx


async def main():
    """Demonstrate command input and autocomplete features."""
    base_url = "http://localhost:8000"
    
    print("Command Input & Autocomplete Example")
    print("=" * 50)
    print()
    
    async with httpx.AsyncClient() as client:
        # Create a session
        response = await client.post(f"{base_url}/sessions")
        session_data = response.json()
        session_id = session_data["session_id"]
        print(f"✓ Created session: {session_id}")
        print()
        
        # Execute some code to populate the namespace
        code1 = "my_variable = 42\nmy_function = lambda x: x * 2"
        response = await client.post(
            f"{base_url}/execute",
            json={"code": code1, "session_id": session_id}
        )
        result = response.json()
        print(f">>> {code1}")
        print(f"✓ Executed successfully")
        print()
        
        # Test autocomplete for keywords
        print("Testing autocomplete for 'fo':")
        response = await client.post(
            f"{base_url}/autocomplete",
            json={
                "code": "fo",
                "position": 2,
                "session_id": session_id,
            }
        )
        completions = response.json()["completions"]
        for comp in completions[:5]:  # Show first 5
            print(f"  - {comp['label']}: {comp['kind']} ({comp.get('detail', 'N/A')})")
        print()
        
        # Test autocomplete for namespace variables
        print("Testing autocomplete for 'my_':")
        response = await client.post(
            f"{base_url}/autocomplete",
            json={
                "code": "my_",
                "position": 3,
                "session_id": session_id,
            }
        )
        completions = response.json()["completions"]
        for comp in completions:
            print(f"  - {comp['label']}: {comp['kind']} ({comp.get('detail', 'N/A')})")
        print()
        
        # Test autocomplete for builtins
        print("Testing autocomplete for 'pri':")
        response = await client.post(
            f"{base_url}/autocomplete",
            json={
                "code": "pri",
                "position": 3,
                "session_id": session_id,
            }
        )
        completions = response.json()["completions"]
        for comp in completions[:5]:  # Show first 5
            print(f"  - {comp['label']}: {comp['kind']} ({comp.get('detail', 'N/A')})")
        print()
        
        # Test multi-line code completion
        print("Testing autocomplete in multi-line code:")
        multiline_code = "x = 1\ny = 2\nz = x + "
        response = await client.post(
            f"{base_url}/autocomplete",
            json={
                "code": multiline_code,
                "position": len(multiline_code),
                "session_id": session_id,
            }
        )
        completions = response.json()["completions"]
        print(f"  Code: {repr(multiline_code)}")
        print(f"  Found {len(completions)} completions")
        print()
        
        # Test completion in the middle of code
        print("Testing autocomplete with 'my_v' in context:")
        response = await client.post(
            f"{base_url}/autocomplete",
            json={
                "code": "result = my_v",
                "position": 13,
                "session_id": session_id,
            }
        )
        completions = response.json()["completions"]
        for comp in completions:
            print(f"  - {comp['label']}: {comp['kind']} ({comp.get('detail', 'N/A')})")
        print()
        
        print("=" * 50)
        print("✓ Command input & autocomplete demonstration complete!")
        print()
        print("To use the Electron frontend:")
        print("  1. Start the backend: uvicorn platform.server.app:app")
        print("  2. Start the Electron app: cd electron && npm start")
        print("  3. Type Python code and use Ctrl+Space for autocomplete")
        print("  4. Press Ctrl+Enter to execute code")
        print("  5. Use ↑/↓ arrow keys to navigate command history")


if __name__ == "__main__":
    print("Starting the backend server first...")
    print("Run: uvicorn platform.server.app:app --host 127.0.0.1 --port 8000")
    print()
    print("Then run this example in another terminal:")
    print("  python examples/command_input_example.py")
    print()
    
    # Try to run the example
    try:
        asyncio.run(main())
    except httpx.ConnectError:
        print("ERROR: Could not connect to backend server.")
        print("Please start the server first with:")
        print("  uvicorn platform.server.app:app --host 127.0.0.1 --port 8000")
