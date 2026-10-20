"""A bounded model/tool loop for one authenticated Coach request."""

from collections.abc import Awaitable, Callable
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from .inference import InferenceError
MAX_TOOL_CALLS = 6
MAX_TOTAL_TOOL_CHARS = 64_000


class CoachState(TypedDict, total=False):
    input: list[dict]
    output: list[dict]
    text: str
    tool_calls: int
    tool_chars: int


def build_coach_graph(respond: Callable[[list[dict]], Awaitable[dict]],
                      run_tool: Callable[[str, str], Awaitable[str]]):
    """Compile model -> optional read-only tool -> model, with a call limit."""

    async def model(state: CoachState) -> CoachState:
        result = await respond(state['input'])
        return {'output': result['output'], 'text': result.get('text', '')}

    def route(state: CoachState) -> str:
        return 'tool' if any(item.get('type') == 'function_call' for item in state['output']) else END

    async def tool(state: CoachState) -> CoachState:
        calls = [item for item in state['output'] if item.get('type') == 'function_call']
        if len(calls) != 1 or state.get('tool_calls', 0) >= MAX_TOOL_CALLS:
            raise InferenceError(502, 'Coach requested too many tools. Try again.')
        call = calls[0]
        if not all(isinstance(call.get(key), str) and call[key] for key in ('name', 'arguments', 'call_id')):
            raise InferenceError(502, 'Coach requested an invalid tool. Try again.')
        result = await run_tool(call['name'], call['arguments'])
        total = state.get('tool_chars', 0) + len(result)
        if total > MAX_TOTAL_TOOL_CHARS:
            raise InferenceError(502, 'Coach requested too much training data. Narrow the question.')
        output = {'type': 'function_call_output', 'call_id': call['call_id'], 'output': result}
        return {
            'input': [*state['input'], *state['output'], output],
            'tool_calls': state.get('tool_calls', 0) + 1,
            'tool_chars': total,
            'text': '',
        }

    graph = StateGraph(CoachState)
    graph.add_node('model', model)
    graph.add_node('tool', tool)
    graph.add_edge(START, 'model')
    graph.add_conditional_edges('model', route, {'tool': 'tool', END: END})
    graph.add_edge('tool', 'model')
    return graph.compile()
