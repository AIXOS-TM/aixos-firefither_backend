const express = require('express');
const router  = express.Router();
const supabase = require('../supabase');

// GET /api/senior-agents
// Admin: list all senior agents with their team member count.
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('senior_agents')
      .select('id, agent_id, is_activated, promoted_by, created_at, agents(id, name, email, status, profile_photo)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Attach team counts
    const ids = (data || []).map(r => r.id);
    let countMap = {};
    if (ids.length > 0) {
      const { data: teams } = await supabase
        .from('senior_agent_teams')
        .select('senior_agent_id')
        .in('senior_agent_id', ids);

      (teams || []).forEach(t => {
        countMap[t.senior_agent_id] = (countMap[t.senior_agent_id] || 0) + 1;
      });
    }

    const result = (data || []).map(r => ({
      ...r,
      team_count: countMap[r.id] || 0,
    }));

    res.json(result);
  } catch (err) {
    console.error('[GET /senior-agents] Error:', err);
    res.status(500).json({ error: 'Failed to fetch senior agents', details: err.message });
  }
});

// GET /api/senior-agents/:id/team
// Returns team members for a given senior_agent record id.
router.get('/:id/team', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('senior_agent_teams')
      .select('id, assigned_at, agent_id, agents(id, name, email, status, profile_photo, territory)')
      .eq('senior_agent_id', id)
      .order('assigned_at', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[GET /senior-agents/:id/team] Error:', err);
    res.status(500).json({ error: 'Failed to fetch team', details: err.message });
  }
});

// PUT /api/senior-agents/:id/team
// Admin: replace the full team assignment for a senior agent.
// Body: { assignedAgentIds: [number...] }  (max 10)
router.put('/:id/team', async (req, res) => {
  const { id } = req.params;
  const { assignedAgentIds = [] } = req.body;

  if (assignedAgentIds.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 team members allowed' });
  }

  try {
    await supabase.from('senior_agent_teams').delete().eq('senior_agent_id', id);

    if (assignedAgentIds.length > 0) {
      const rows = assignedAgentIds.slice(0, 10).map(memberId => ({
        senior_agent_id: Number(id),
        agent_id: Number(memberId),
      }));
      const { error } = await supabase.from('senior_agent_teams').insert(rows);
      if (error) throw error;
    }

    res.json({ message: 'Team updated successfully' });
  } catch (err) {
    console.error('[PUT /senior-agents/:id/team] Error:', err);
    res.status(500).json({ error: 'Failed to update team', details: err.message });
  }
});

// DELETE /api/senior-agents/agent/:agentId
// Admin: remove senior agent status for an agent.
router.delete('/agent/:agentId', async (req, res) => {
  const { agentId } = req.params;
  try {
    const { error } = await supabase
      .from('senior_agents')
      .delete()
      .eq('agent_id', agentId);

    if (error) throw error;
    res.json({ message: 'Senior agent status removed' });
  } catch (err) {
    console.error('[DELETE /senior-agents/agent/:agentId] Error:', err);
    res.status(500).json({ error: 'Failed to remove senior agent', details: err.message });
  }
});

module.exports = router;
