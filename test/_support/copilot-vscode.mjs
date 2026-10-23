// Synthetic ISerializableChatData3; no user transcript or provider connection.
export const COPILOT_TIME = 1786000000000
export function copilotVscodeFixture(overrides = {}) {
  return {
    version: 3, sessionId: 'copilot-example', customTitle: 'Named example',
    creationDate: COPILOT_TIME,
    requests: [
      {
        requestId: 'request-one', timestamp: COPILOT_TIME + 100,
        responseTimestamp: COPILOT_TIME + 110, modelId: 'example-model',
        message: { text: 'Inspect example', parts: [{ kind: 'text', text: 'Inspect example' }] },
        response: [
          { value: 'First ' }, { value: 'look.' },
          { kind: 'thinking', value: ['Read the example.'] },
          { kind: 'prepareToolInvocation', toolCallId: 'read-one', toolId: 'readFile' },
          {
            kind: 'toolInvocationSerialized', toolCallId: 'read-one', toolId: 'readFile',
            isComplete: true, isConfirmed: true,
            startedAt: COPILOT_TIME + 120, completedAt: COPILOT_TIME + 130,
            toolSpecificData: { kind: 'input', rawInput: { path: 'example.txt' } },
            resultDetails: {
              input: '{"path":"example.txt"}',
              output: [{ type: 'embed', isText: true, value: 'example output' }],
            },
          },
          { value: 'Done.' },
          { kind: 'inlineReference', inlineReference: { name: 'example.txt' } },
        ],
      },
      {
        requestId: 'request-two', timestamp: COPILOT_TIME + 200,
        message: 'Explain the result',
        response: [{ kind: 'thinking', value: 'Check the stored result.' }, { value: 'Explanation.' }],
      },
      {
        requestId: 'request-three', timestamp: COPILOT_TIME + 300,
        message: { parts: [{ kind: 'text', text: 'Keep ' }, { kind: 'text', text: 'the context' }] },
        response: [{ value: 'Ready.' }],
      },
    ],
    ...overrides,
  }
}
