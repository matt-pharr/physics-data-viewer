"""
Example demonstrating the Python command input with autocomplete (PR #7).

This example shows how to:
1. Start the backend server
2. Use the BackendClient to execute commands
3. Get autocomplete suggestions
4. Navigate command history

Prerequisites:
- Backend server running: uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
"""

import asyncio
from platform.gui.client import BackendClient
from platform.gui.command_input.history import CommandHistory
from pathlib import Path


async def main():
    # Initialize the backend client
    client = BackendClient("http://localhost:8000")
    
    # Create a session
    session_id = await client.connect()
    print(f"Connected to backend with session: {session_id}\n")
    
    # Initialize command history
    history_file = Path("/tmp/physics_viewer_history.json")
    history = CommandHistory(history_file=history_file)
    
    # Example 1: Execute some Python commands
    print("=" * 60)
    print("Example 1: Executing Python commands")
    print("=" * 60)
    
    commands = [
        "x = 42",
        "y = x * 2",
        "result = x + y",
        "print(f'x={x}, y={y}, result={result}')",
    ]
    
    for cmd in commands:
        print(f"\n> {cmd}")
        history.add(cmd)
        result = await client.execute(cmd, session_id=session_id)
        if result.stdout:
            print(f"Output: {result.stdout.strip()}")
        if result.error:
            print(f"Error: {result.error}")
    
    # Example 2: Get autocomplete suggestions
    print("\n" + "=" * 60)
    print("Example 2: Autocomplete suggestions")
    print("=" * 60)
    
    # Test keyword completion
    code = "imp"
    print(f"\nCode: '{code}'")
    completions = await client.get_completions(session_id, code, len(code))
    print(f"Completions: {completions[:5]}")  # Show first 5
    
    # Test state variable completion
    code = "res"
    print(f"\nCode: '{code}'")
    completions = await client.get_completions(session_id, code, len(code))
    print(f"Completions: {completions}")
    
    # Test builtin completion
    code = "pri"
    print(f"\nCode: '{code}'")
    completions = await client.get_completions(session_id, code, len(code))
    print(f"Completions: {completions}")
    
    # Example 3: Command history navigation
    print("\n" + "=" * 60)
    print("Example 3: Command history navigation")
    print("=" * 60)
    
    print("\nAll commands in history:")
    for i, cmd in enumerate(history.get_all(), 1):
        print(f"  {i}. {cmd}")
    
    print("\nNavigating backwards:")
    print(f"  Previous: {history.previous()}")
    print(f"  Previous: {history.previous()}")
    print(f"  Previous: {history.previous()}")
    
    print("\nNavigating forwards:")
    print(f"  Next: {history.next()}")
    print(f"  Next: {history.next()}")
    
    # Example 4: Search history
    print("\n" + "=" * 60)
    print("Example 4: Searching command history")
    print("=" * 60)
    
    search_results = history.search("print")
    print(f"\nCommands containing 'print':")
    for cmd in search_results:
        print(f"  - {cmd}")
    
    # Example 5: Multi-line code with autocomplete
    print("\n" + "=" * 60)
    print("Example 5: Multi-line code")
    print("=" * 60)
    
    multiline_code = """
def greet(name):
    return f"Hello, {name}!"

message = greet("Physicist")
print(message)
"""
    
    print(f"\nExecuting multi-line code:")
    print(multiline_code)
    
    history.add(multiline_code)
    result = await client.execute(multiline_code, session_id=session_id)
    if result.stdout:
        print(f"Output: {result.stdout.strip()}")
    
    # Get final state
    state = await client.get_state(session_id)
    print(f"\n" + "=" * 60)
    print("Final session state:")
    print("=" * 60)
    for key in sorted(state.keys()):
        if not key.startswith('__'):
            print(f"  {key}: {state[key]}")
    
    # Show that history persists
    print(f"\n" + "=" * 60)
    print("Command history persisted to: {history_file}")
    print(f"Total commands in history: {len(history.get_all())}")
    print("=" * 60)
    
    # Cleanup
    await client.aclose()
    print("\nExample complete!")


if __name__ == "__main__":
    print("Python Command Input & Autocomplete Example (PR #7)")
    print("\nMake sure the backend server is running:")
    print("  uvicorn platform.server.app:app --host 127.0.0.1 --port 8000\n")
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
    except Exception as e:
        print(f"\nError: {e}")
        print("\nIs the backend server running?")
