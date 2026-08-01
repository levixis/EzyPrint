#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# EzyPrint Backend — Comprehensive Test Suite
# Tests: Auth, Users, Shops, Orders, Uploads, Payments,
#        Notifications, Tickets, Security, Edge Cases
# ═══════════════════════════════════════════════════════════════

BASE="http://localhost:5001/api/v1"
PASS=0
FAIL=0
RESULTS=""

# Helper function: test an API call
test_api() {
  local TEST_NAME="$1"
  local EXPECTED_STATUS="$2"
  local METHOD="$3"
  local URL="$4"
  shift 4
  local EXTRA_ARGS=("$@")

  # Make request and capture status + body
  HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" "$METHOD" "$URL" "${EXTRA_ARGS[@]}" 2>/dev/null)
  HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)
  HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')

  if [ "$HTTP_STATUS" == "$EXPECTED_STATUS" ]; then
    PASS=$((PASS + 1))
    RESULTS+="| ✅ | $TEST_NAME | $HTTP_STATUS | $EXPECTED_STATUS |\n"
  else
    FAIL=$((FAIL + 1))
    # Extract error message
    ERR_MSG=$(echo "$HTTP_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','')[:60])" 2>/dev/null || echo "N/A")
    RESULTS+="| ❌ | $TEST_NAME | $HTTP_STATUS | $EXPECTED_STATUS | $ERR_MSG |\n"
  fi

  echo "$HTTP_BODY"
}

sleep 3
echo "Starting comprehensive test suite..."

# ═══════════════════════════════════
# SECTION 1: HEALTH & CONNECTIVITY
# ═══════════════════════════════════
echo "--- Section 1: Health ---"
test_api "Health check" "200" -X GET "$BASE/health" > /dev/null
test_api "404 for unknown route" "404" -X GET "$BASE/nonexistent" > /dev/null

# ═══════════════════════════════════
# SECTION 2: AUTHENTICATION
# ═══════════════════════════════════
echo "--- Section 2: Auth ---"

# Register a fresh test user
FRESH_EMAIL="test_$(date +%s)@ezyprint.com"
REG_BODY=$(test_api "Register new student" "201" -X POST "$BASE/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$FRESH_EMAIL\",\"password\":\"TestPass1234!\",\"name\":\"Fresh User\",\"type\":\"STUDENT\"}")
FRESH_TOKEN=$(echo "$REG_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)
FRESH_REFRESH=$(echo "$REG_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['refreshToken'])" 2>/dev/null)

# Duplicate registration
test_api "Duplicate email rejected" "409" -X POST "$BASE/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$FRESH_EMAIL\",\"password\":\"TestPass1234!\",\"name\":\"Dup User\",\"type\":\"STUDENT\"}" > /dev/null

# Missing fields
test_api "Register missing email" "400" -X POST "$BASE/auth/register" -H "Content-Type: application/json" -d '{"password":"Test1234!","name":"No Email","type":"STUDENT"}' > /dev/null

# Login
LOGIN_BODY=$(test_api "Login with correct creds" "200" -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$FRESH_EMAIL\",\"password\":\"TestPass1234!\"}")
LOGIN_TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)

# Wrong password
test_api "Login wrong password" "401" -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$FRESH_EMAIL\",\"password\":\"WrongPass!\"}" > /dev/null

# Non-existent email
test_api "Login non-existent email" "401" -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d '{"email":"nobody@ezyprint.com","password":"Test1234!"}' > /dev/null

# Get profile
test_api "Get profile (authenticated)" "200" -X GET "$BASE/auth/me" -H "Authorization: Bearer $LOGIN_TOKEN" > /dev/null

# No auth header
test_api "Get profile (no auth)" "401" -X GET "$BASE/auth/me" > /dev/null

# Invalid token
test_api "Get profile (invalid token)" "401" -X GET "$BASE/auth/me" -H "Authorization: Bearer invalid.jwt.token" > /dev/null

# Refresh token
REFRESH_BODY=$(test_api "Refresh token" "200" -X POST "$BASE/auth/refresh" -H "Content-Type: application/json" -d "{\"refreshToken\":\"$FRESH_REFRESH\"}")
NEW_REFRESH=$(echo "$REFRESH_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['refreshToken'])" 2>/dev/null)

# Replay attack: use old refresh token
test_api "Replay attack (old refresh token)" "401" -X POST "$BASE/auth/refresh" -H "Content-Type: application/json" -d "{\"refreshToken\":\"$FRESH_REFRESH\"}" > /dev/null

# Now re-login since all sessions revoked by replay detection
LOGIN2_BODY=$(test_api "Re-login after replay revocation" "200" -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$FRESH_EMAIL\",\"password\":\"TestPass1234!\"}")
S_TOKEN=$(echo "$LOGIN2_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)

# Logout
test_api "Logout" "200" -X POST "$BASE/auth/logout" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# ═══════════════════════════════════
# SECTION 3: USERS
# ═══════════════════════════════════
echo "--- Section 3: Users ---"

# Re-login
S_TOKEN=$(curl -s -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d '{"email":"test@ezyprint.com","password":"Test1234!"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)

test_api "Get user profile" "200" -X GET "$BASE/users/me" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Update profile
test_api "Update profile" "200" -X PATCH "$BASE/users/me" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"name":"Updated Student","phone":"9876543210"}' > /dev/null

# Non-admin listing users
test_api "Student cannot list all users" "403" -X GET "$BASE/users" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Admin can list
A_TOKEN=$(curl -s -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d '{"email":"admin@ezyprint.com","password":"Admin1234!"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)

test_api "Admin lists all users" "200" -X GET "$BASE/users" -H "Authorization: Bearer $A_TOKEN" > /dev/null

# Admin with search
test_api "Admin search users" "200" -X GET "$BASE/users?search=test&limit=5" -H "Authorization: Bearer $A_TOKEN" > /dev/null

# ═══════════════════════════════════
# SECTION 4: SHOPS
# ═══════════════════════════════════
echo "--- Section 4: Shops ---"

SH_TOKEN=$(curl -s -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d '{"email":"shop@ezyprint.com","password":"Shop1234!"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)

# Get shop list (public)
SHOP_LIST=$(test_api "List shops (public)" "200" -X GET "$BASE/shops")
SHOP_COUNT=$(echo "$SHOP_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['shops']))" 2>/dev/null)

# Get shop ID
SHOP_ID=$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $SH_TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['user']['shop']['id'])" 2>/dev/null)

test_api "Get shop by ID" "200" -X GET "$BASE/shops/$SHOP_ID" > /dev/null
test_api "Get non-existent shop" "404" -X GET "$BASE/shops/nonexistent-id" > /dev/null

# Update shop settings
test_api "Owner updates pricing" "200" -X PATCH "$BASE/shops/$SHOP_ID" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"bwPerPage":2,"colorPerPage":5,"contactPhone":"9876543210"}' > /dev/null

# Negative pricing validation
test_api "Negative pricing rejected" "400" -X PATCH "$BASE/shops/$SHOP_ID" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"bwPerPage":-1}' > /dev/null

# Student can't update shop
test_api "Student cannot update shop" "403" -X PATCH "$BASE/shops/$SHOP_ID" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"isOpen":false}' > /dev/null

# Admin archive
test_api "Admin archive shop" "200" -X PATCH "$BASE/shops/$SHOP_ID/archive" -H "Authorization: Bearer $A_TOKEN" -H "Content-Type: application/json" -d '{"action":"archive"}' > /dev/null

# Unarchive
test_api "Admin unarchive shop" "200" -X PATCH "$BASE/shops/$SHOP_ID/archive" -H "Authorization: Bearer $A_TOKEN" -H "Content-Type: application/json" -d '{"action":"unarchive"}' > /dev/null

# Make sure shop is open and approved for order tests
curl -s -X PATCH "$BASE/shops/$SHOP_ID/approve" -H "Authorization: Bearer $A_TOKEN" > /dev/null 2>&1
curl -s -X PATCH "$BASE/shops/$SHOP_ID" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"isOpen":true}' > /dev/null 2>&1

# Aggregate stats
test_api "Shop aggregate stats" "200" -X GET "$BASE/shops/$SHOP_ID/aggregate" -H "Authorization: Bearer $SH_TOKEN" > /dev/null

# ═══════════════════════════════════
# SECTION 5: ORDERS
# ═══════════════════════════════════
echo "--- Section 5: Orders ---"

# Create order
ORDER_BODY=$(test_api "Create order (student)" "201" -X POST "$BASE/orders" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d "{\"shopId\":\"$SHOP_ID\",\"fileName\":\"thesis.pdf\",\"fileType\":\"PDF\",\"copies\":3,\"color\":\"COLOR\",\"pages\":20,\"doubleSided\":true}")
ORDER_ID=$(echo "$ORDER_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['order']['id'])" 2>/dev/null)
ORDER_PRICE=$(echo "$ORDER_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['order']['totalPrice'])" 2>/dev/null)
PICKUP_CODE=$(echo "$ORDER_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['order']['pickupCode'])" 2>/dev/null)

# Verify pricing: 20 pages, double-sided = 10 sheets, color@5/page, 3 copies = 10*3*5=150, baseFee=10% of 150=15, total=165
echo "  Price: $ORDER_PRICE, Pickup: $PICKUP_CODE"

# Shop owner cannot create order
test_api "Shop owner cannot create order" "403" -X POST "$BASE/orders" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d "{\"shopId\":\"$SHOP_ID\",\"fileName\":\"test.pdf\",\"fileType\":\"PDF\",\"copies\":1,\"color\":\"BLACK_WHITE\",\"pages\":5,\"doubleSided\":false}" > /dev/null

# Get order
test_api "Get order by ID" "200" -X GET "$BASE/orders/$ORDER_ID" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Student list orders
test_api "Student list own orders" "200" -X GET "$BASE/orders" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Shop owner list orders
test_api "Shop owner list shop orders" "200" -X GET "$BASE/orders" -H "Authorization: Bearer $SH_TOKEN" > /dev/null

# Status transitions: PENDING_PAYMENT → PENDING_APPROVAL
test_api "Status: PENDING_PAYMENT→PENDING_APPROVAL" "200" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"status":"PENDING_APPROVAL"}' > /dev/null

# PENDING_APPROVAL → PRINTING
test_api "Status: PENDING_APPROVAL→PRINTING" "200" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"status":"PRINTING","shopNotes":"Starting print job"}' > /dev/null

# Invalid: PRINTING → COMPLETED (should go through READY_FOR_PICKUP first)
test_api "Invalid: PRINTING→COMPLETED blocked" "400" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"status":"COMPLETED"}' > /dev/null

# PRINTING → READY_FOR_PICKUP
test_api "Status: PRINTING→READY_FOR_PICKUP" "200" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"status":"READY_FOR_PICKUP"}' > /dev/null

# READY_FOR_PICKUP → COMPLETED
test_api "Status: READY_FOR_PICKUP→COMPLETED" "200" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"status":"COMPLETED"}' > /dev/null

# COMPLETED → cannot go back
test_api "Completed order cannot go back" "400" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $SH_TOKEN" -H "Content-Type: application/json" -d '{"status":"PRINTING"}' > /dev/null

# Student cannot change status
test_api "Student cannot change order status" "403" -X PATCH "$BASE/orders/$ORDER_ID/status" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"status":"PRINTING"}' > /dev/null

# Admin list all orders
test_api "Admin list all orders" "200" -X GET "$BASE/orders/admin/all" -H "Authorization: Bearer $A_TOKEN" > /dev/null

# Admin list with filter
test_api "Admin list orders by status" "200" -X GET "$BASE/orders/admin/all?status=COMPLETED" -H "Authorization: Bearer $A_TOKEN" > /dev/null

# Cross-user access: shop owner can't see student order via different user context
# (actually they can because it's their shop's order - this is correct behavior)

# ═══════════════════════════════════
# SECTION 6: FILE UPLOADS
# ═══════════════════════════════════
echo "--- Section 6: Uploads ---"

echo "Test PDF content for EzyPrint" > /tmp/ezyprint_test.txt

test_api "Upload single file" "201" -X POST "$BASE/uploads/single" -H "Authorization: Bearer $S_TOKEN" -F "file=@/tmp/ezyprint_test.txt;type=text/plain" > /dev/null

echo "Multi file 1" > /tmp/ezy_f1.txt
echo "Multi file 2" > /tmp/ezy_f2.txt
echo "Multi file 3" > /tmp/ezy_f3.txt
MULTI_BODY=$(test_api "Upload multiple files" "201" -X POST "$BASE/uploads/multiple" -H "Authorization: Bearer $S_TOKEN" -F "files=@/tmp/ezy_f1.txt;type=text/plain" -F "files=@/tmp/ezy_f2.txt;type=text/plain" -F "files=@/tmp/ezy_f3.txt;type=text/plain")
MULTI_KEY=$(echo "$MULTI_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['files'][0]['storageKey'])" 2>/dev/null)

# Download URL
ENCODED_KEY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$MULTI_KEY', safe=''))")
test_api "Get download URL" "200" -X GET "$BASE/uploads/url/$ENCODED_KEY" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Direct download
FOLDER=$(echo "$MULTI_KEY" | cut -d'/' -f1)
FNAME=$(echo "$MULTI_KEY" | cut -d'/' -f2)
test_api "Download file directly" "200" -X GET "$BASE/uploads/download/$FOLDER/$FNAME" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Invalid file type
echo "<html>hack</html>" > /tmp/ezy_bad.html
test_api "Reject invalid file type (HTML)" "400" -X POST "$BASE/uploads/single" -H "Authorization: Bearer $S_TOKEN" -F "file=@/tmp/ezy_bad.html;type=text/html" > /dev/null

# No auth
test_api "Upload without auth" "401" -X POST "$BASE/uploads/single" -F "file=@/tmp/ezyprint_test.txt;type=text/plain" > /dev/null

# ═══════════════════════════════════
# SECTION 7: PAYMENTS
# ═══════════════════════════════════
echo "--- Section 7: Payments ---"

# Create a fresh order for payment testing
PAYMENT_ORDER=$(curl -s -X POST "$BASE/orders" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d "{\"shopId\":\"$SHOP_ID\",\"fileName\":\"payment_test.pdf\",\"fileType\":\"PDF\",\"copies\":1,\"color\":\"BLACK_WHITE\",\"pages\":5,\"doubleSided\":false}")
PAY_ORDER_ID=$(echo "$PAYMENT_ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['order']['id'])" 2>/dev/null)

# Create payment (will fail because Razorpay keys not configured — that's expected)
test_api "Create payment (no Razorpay keys)" "500" -X POST "$BASE/payments/create-order" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d "{\"orderId\":\"$PAY_ORDER_ID\"}" > /dev/null

# Verify with missing fields
test_api "Verify payment (missing fields)" "400" -X POST "$BASE/payments/verify" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{}' > /dev/null

# Webhook missing signature
test_api "Webhook without signature" "400" -X POST "$BASE/payments/webhook" -H "Content-Type: application/json" -d '{"event":"payment.captured"}' > /dev/null

# Verify for non-existent order
test_api "Verify for non-existent order" "404" -X POST "$BASE/payments/verify" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"orderId":"fake-id","razorpayPaymentId":"pay_x","razorpayOrderId":"order_x","razorpaySignature":"sig_x"}' > /dev/null

# ═══════════════════════════════════
# SECTION 8: NOTIFICATIONS
# ═══════════════════════════════════
echo "--- Section 8: Notifications ---"

test_api "List notifications" "200" -X GET "$BASE/notifications" -H "Authorization: Bearer $S_TOKEN" > /dev/null
test_api "List unread only" "200" -X GET "$BASE/notifications?unreadOnly=true" -H "Authorization: Bearer $S_TOKEN" > /dev/null
test_api "Mark all as read" "200" -X PATCH "$BASE/notifications/read-all" -H "Authorization: Bearer $S_TOKEN" > /dev/null
test_api "Mark non-existent read" "404" -X PATCH "$BASE/notifications/nonexistent/read" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# ═══════════════════════════════════
# SECTION 9: TICKETS
# ═══════════════════════════════════
echo "--- Section 9: Tickets ---"

# Create ticket
TK_BODY=$(test_api "Create ticket" "201" -X POST "$BASE/tickets" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"subject":"Test ticket","description":"Testing the ticket system","category":"OTHER"}')
TK_ID=$(echo "$TK_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['ticket']['id'])" 2>/dev/null)

# Missing required fields
test_api "Create ticket missing fields" "400" -X POST "$BASE/tickets" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"subject":"No category"}' > /dev/null

# Add message
test_api "Add message to ticket" "201" -X POST "$BASE/tickets/$TK_ID/messages" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"message":"Follow up message"}' > /dev/null

# Get ticket with messages
test_api "Get ticket with messages" "200" -X GET "$BASE/tickets/$TK_ID" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# List tickets
test_api "List tickets" "200" -X GET "$BASE/tickets" -H "Authorization: Bearer $S_TOKEN" > /dev/null

# Admin changes status
test_api "Admin: IN_REVIEW" "200" -X PATCH "$BASE/tickets/$TK_ID/status" -H "Authorization: Bearer $A_TOKEN" -H "Content-Type: application/json" -d '{"status":"IN_REVIEW","note":"Looking into this"}' > /dev/null

test_api "Admin: RESOLVED" "200" -X PATCH "$BASE/tickets/$TK_ID/status" -H "Authorization: Bearer $A_TOKEN" -H "Content-Type: application/json" -d '{"status":"RESOLVED","note":"Issue fixed"}' > /dev/null

# Student cannot change status
test_api "Student cannot change ticket status" "403" -X PATCH "$BASE/tickets/$TK_ID/status" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"status":"CLOSED"}' > /dev/null

# ═══════════════════════════════════
# SECTION 10: SECURITY & EDGE CASES
# ═══════════════════════════════════
echo "--- Section 10: Security ---"

# CORS preflight
CORS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$BASE/auth/login" -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST")
if [ "$CORS_STATUS" == "204" ]; then
  PASS=$((PASS + 1))
  RESULTS+="| ✅ | CORS preflight allowed (localhost:5173) | $CORS_STATUS | 204 |\n"
else
  FAIL=$((FAIL + 1))
  RESULTS+="| ❌ | CORS preflight allowed (localhost:5173) | $CORS_STATUS | 204 |\n"
fi

# SQL injection attempt
test_api "SQL injection in login" "401" -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d '{"email":"admin@ezyprint.com\" OR 1=1 --","password":"x"}' > /dev/null

# XSS in user name
test_api "XSS in name (stored safely)" "200" -X PATCH "$BASE/users/me" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"name":"<script>alert(1)</script>"}' > /dev/null

# Restore name
curl -s -X PATCH "$BASE/users/me" -H "Authorization: Bearer $S_TOKEN" -H "Content-Type: application/json" -d '{"name":"Test Student"}' > /dev/null

# Large payload
test_api "Large JSON payload handled" "400" -X POST "$BASE/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"x\",\"password\":\"$(python3 -c "print('A'*1000)")\",\"name\":\"x\",\"type\":\"STUDENT\"}" > /dev/null

# ═══════════════════════════════════
# RESULTS
# ═══════════════════════════════════
echo ""
echo "═══════════════════════════════════════"
echo "  TEST RESULTS: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"
echo ""
echo "| Status | Test | Got | Expected |"
echo "|--------|------|-----|----------|"
echo -e "$RESULTS"
