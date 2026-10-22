"""A bounded model/tool loop for one authenticated Coach request."""

import json
from collections.abc import Awaitable, Callable
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from .inference import InferenceError
# Plan changes commonly need a profile, plan, exercise, and history lookup before
# the proposal can be constructed. Keep the limit finite while allowing that path.
MAX_TOOL_CALLS = 12
MAX_TOTAL_TOOL_BYTES = 64_000
MAX_TOOL_ARGUMENT_BYTES = 50_000


class CoachState(TypedDict, total=False):
    input: list[dict]
    output: list[dict]
    text: str
    tool_calls: int
    tool_bytes: int
    proposal: dict


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
        if len(call['arguments'].encode('utf-8')) > MAX_TOOL_ARGUMENT_BYTES:
            raise InferenceError(502, 'Coach tool arguments were too large. Narrow the request and try again.')
        if state.get('proposal') and call['name'] in ('propose_training_plan', 'propose_plan_changes'):
            raise InferenceError(502, 'Coach already created a proposal in this request. Review that proposal before asking for another.')
        result = await run_tool(call['name'], call['arguments'])
        total = state.get('tool_bytes', 0) + len(result.encode('utf-8'))
        if total > MAX_TOTAL_TOOL_BYTES:
            raise InferenceError(502, 'Coach requested too much training data. Narrow the question.')
        output = {'type': 'function_call_output', 'call_id': call['call_id'], 'output': result}
        proposal = state.get('proposal')
        try:
            structured = json.loads(result)
            if isinstance(structured, dict) and isinstance(structured.get('proposal'), dict):
                proposal = structured['proposal']
        except (ValueError, TypeError):
            pass
        return {
            'input': [*state['input'], *state['output'], output],
            'tool_calls': state.get('tool_calls', 0) + 1,
            'tool_bytes': total,
            'text': '',
            'proposal': proposal,
        }

    graph = StateGraph(CoachState)
    graph.add_node('model', model)
    graph.add_node('tool', tool)
    graph.add_edge(START, 'model')
    graph.add_conditional_edges('model', route, {'tool': 'tool', END: END})
    graph.add_edge('tool', 'model')
    return graph.compile()
