package settings

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/getkimchi/kimchi-adapters/internal/delivery"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

func TestAccountsAndUnverifiedHistoryStaySeparate(t *testing.T) {
	t.Setenv("KIMCHI_ADAPTERS_HOME", t.TempDir())
	actor := protocol.NewID()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"id": actor, "username": "auth0|fixture"})
	}))
	defer server.Close()
	c := Config{Config: delivery.Config{APIURL: server.URL, OrganizationID: protocol.NewID(), APIKey: "one"}}
	local := c.StateDir()
	var err error
	c.Config, err = delivery.Authenticate(t.Context(), c.Config)
	if err != nil {
		t.Fatal(err)
	}
	first := c.StateDir()
	if first == local {
		t.Fatal("unknown local records assigned to login")
	}
	c.APIKey = "rotated-for-same-user"
	c.Config, err = delivery.Authenticate(t.Context(), c.Config)
	if err != nil || c.StateDir() != first {
		t.Fatal("same-user key rotation lost account", err)
	}
	actor = protocol.NewID()
	c.Config, err = delivery.Authenticate(t.Context(), c.Config)
	if err != nil || c.StateDir() == first || c.StateDir() == local {
		t.Fatal("actor switch reused another account", err)
	}
}
