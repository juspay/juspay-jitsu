package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestBulkerProxyStripsInternalPrefixAndPreservesRequest(t *testing.T) {
	var gotPath, gotQuery, gotAuthorization, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath = req.URL.Path
		gotQuery = req.URL.RawQuery
		gotAuthorization = req.Header.Get("Authorization")
		body, err := io.ReadAll(req.Body)
		require.NoError(t, err)
		gotBody = string(body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	proxy, err := newBulkerProxy(upstream.URL)
	require.NoError(t, err)
	router := &Router{bulkerProxy: proxy}
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Any("/internal/bulker/*path", router.BulkerProxyHandler)

	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/bulker/post/destination-1?tableName=profiles",
		strings.NewReader(`{"profile_id":"user-1"}`),
	)
	req.Header.Set("Authorization", "Bearer test-token")
	res := httptest.NewRecorder()
	engine.ServeHTTP(res, req)

	require.Equal(t, http.StatusAccepted, res.Code)
	require.Equal(t, "/post/destination-1", gotPath)
	require.Equal(t, "tableName=profiles", gotQuery)
	require.Equal(t, "Bearer test-token", gotAuthorization)
	require.JSONEq(t, `{"profile_id":"user-1"}`, gotBody)
}
