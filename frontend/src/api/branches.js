import { client, apiCall } from './client'

/** Branches the signed-in user can access + whether they get the
 *  consolidated (all-branches) view. Drives the branch selector + switcher. */
export const getMyBranches = () =>
  apiCall(() => client.get('/api/branches/my/'))

/** Owner: the branch ids granted to a staff user. */
export const getBranchAssignments = (userId) =>
  apiCall(() => client.get('/api/branches/assignments/', { params: { user_id: userId } }))

/** Owner: set which branches a staff user may access, and which of those they
 *  manage (branch managers reach the all-branches dashboard for their branches). */
export const assignBranches = (userId, branchIds, manageBranchIds = []) =>
  apiCall(() => client.post('/api/branches/assign/', {
    user_id: userId, branch_ids: branchIds, manage_branch_ids: manageBranchIds,
  }))
