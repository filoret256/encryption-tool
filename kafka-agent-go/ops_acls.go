// Reading a cluster's ACLs: who may do what to which resource (K-44).
//
// One read, and one request: Kafka's DescribeACLs takes a filter, and a filter of "any
// resource, any operation, any principal" answers with every ACL the login may see. The
// page filters what it got — the list is a table a person reads, and a second round trip
// per keystroke would be the wrong shape for it.
//
// Only the ACL listing lives here. Creating and deleting ACLs is not in the phase 3 plan,
// and the agent has no op for them: what a page may change on a cluster is listed in
// server.go, and nothing here is a write.
package main

import (
	"sort"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// allACLs is the filter that matches everything: any resource, any name, any operation,
// any principal, any host, either permission, any pattern.
//
// Both the allow and the deny side are asked for by name because the library only collapses
// them into one "any" filter when all four are set — and a listing that quietly left out the
// deny ACLs would be worse than no listing at all.
//
// The pattern must be asked for as MATCH. The library's default is LITERAL, which is the
// deliberate choice for a delete, and it would leave every prefixed and wildcard ACL out of
// the answer: a listing that hides ACLs is the one thing it must not do.
func allACLs() *kadm.ACLBuilder {
	return kadm.NewACLs().AnyResource().Operations().Allow().Deny().AllowHosts().DenyHosts().
		ResourcePatternType(kadm.ACLPatternMatch)
}

// aclsList answers with every ACL on the cluster.
func aclsList(c *opCtx, p clusterParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()
	res, err := t.adm.DescribeACLs(t.ctx, allACLs())
	if err != nil {
		return nil, t.fail(err)
	}
	out := []aclEntry{}
	seen := map[aclEntry]bool{}
	for _, r := range res {
		if r.Err != nil {
			msg := r.Err.Error()
			if r.ErrMessage != "" {
				msg = r.ErrMessage
			}
			return nil, &opError{Code: "EKAFKA", Message: "The cluster did not list its ACLs: " + msg}
		}
		for _, a := range r.Described {
			e := aclEntry{
				Principal:    a.Principal,
				Host:         a.Host,
				ResourceType: resourceTypeName(a.Type),
				ResourceName: a.Name,
				PatternType:  patternName(a.Pattern),
				Operation:    a.Operation.String(),
				Permission:   permissionName(a.Permission),
			}
			// A listing with several filters can name the same ACL twice, and Kafka's own
			// tool hides that. Two identical rows would look like two ACLs.
			if seen[e] {
				continue
			}
			seen[e] = true
			out = append(out, e)
		}
	}
	// The same order every time: by who, then by what they may do it to.
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Principal != b.Principal {
			return a.Principal < b.Principal
		}
		if a.ResourceType != b.ResourceType {
			return a.ResourceType < b.ResourceType
		}
		if a.ResourceName != b.ResourceName {
			return a.ResourceName < b.ResourceName
		}
		return a.Operation < b.Operation
	})
	return aclList{ACLs: out}, nil
}

// resourceTypeName names a resource the way the page shows it.
func resourceTypeName(t kmsg.ACLResourceType) string {
	switch t {
	case kmsg.ACLResourceTypeTopic:
		return "topic"
	case kmsg.ACLResourceTypeGroup:
		return "group"
	case kmsg.ACLResourceTypeCluster:
		return "cluster"
	case kmsg.ACLResourceTypeTransactionalId:
		return "transactional_id"
	case kmsg.ACLResourceTypeDelegationToken:
		return "delegation_token"
	}
	return "any"
}

// patternName names how the resource name is matched.
func patternName(p kadm.ACLPattern) string {
	switch p {
	case kadm.ACLPatternMatch:
		return "match"
	case kadm.ACLPatternLiteral:
		return "literal"
	case kadm.ACLPatternPrefixed:
		return "prefixed"
	}
	return "any"
}

// permissionName is allow or deny.
func permissionName(p kmsg.ACLPermissionType) string {
	switch p {
	case kmsg.ACLPermissionTypeAllow:
		return "allow"
	case kmsg.ACLPermissionTypeDeny:
		return "deny"
	}
	return "any"
}
