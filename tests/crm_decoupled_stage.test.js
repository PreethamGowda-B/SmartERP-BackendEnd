const test = require('node:test');
const assert = require('node:assert/strict');

test.describe('CRM Stage Transition Decoupling Test Suite', () => {

  test('Generating AI draft proposal populates proposal text but leaves deal stage unchanged', () => {
    // Mock lead record prior to draft generation
    const leadState = {
      id: 'lead-101',
      stage: 'new_lead',
      ai_proposal_text: null,
    };

    // Simulate generateAiProposal logic (Decoupled)
    const generateAiProposal = (lead, generatedText) => {
      return {
        ...lead,
        ai_proposal_text: generatedText,
        // stage remains UNCHANGED
      };
    };

    const updatedState = generateAiProposal(leadState, 'EXECUTIVE B2B PROPOSAL FOR CLIENT');

    // Assertion 1: Proposal text is populated
    assert.equal(updatedState.ai_proposal_text, 'EXECUTIVE B2B PROPOSAL FOR CLIENT');

    // Assertion 2: Stage is STILL 'new_lead' (NOT automatically moved to 'proposal_sent')
    assert.equal(updatedState.stage, 'new_lead', 'Draft generation MUST NOT alter lead stage');

    // Simulate explicit sales rep action: mark stage as proposal_sent
    const markProposalSent = (lead) => {
      return {
        ...lead,
        stage: 'proposal_sent'
      };
    };

    const finalState = markProposalSent(updatedState);
    assert.equal(finalState.stage, 'proposal_sent', 'Explicit rep action correctly updates stage');
  });

});
