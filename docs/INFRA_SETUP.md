# 인프라 세팅 가이드 (Oracle Cloud + galle.cloud)

> 목표: `https://galle.cloud`에서 Oracle Cloud Always Free VM 한 대로 서비스를 운영한다. 비용 0원.
> 이 문서는 순서대로 따라 하면 되도록 썼다. 각 단계 끝의 **✅ 확인**을 통과한 뒤 다음 단계로 넘어간다.

### 진행 기록
| 날짜 | 단계 | 결과 |
|---|---|---|
| 2026-11-09 | §3 가입 | 완료. 홈 리전 **도쿄(ap-tokyo-1)** |
| 2026-11-09 | §5-1 VCN | `live-vcn` (마법사 "인터넷 접속을 통한 VCN 생성") |
| 2026-11-09 | §5-3 인스턴스 | A1은 AD-1 용량 부족으로 실패 → **VM.Standard.E2.1.Micro (1GB)**로 생성 |
| 2026-11-09 | §6-1 접속 | SSH 접속, 셰이프 확인 완료 (x86_64, 952Mi, 96G, Ubuntu 24.04.5) |
| 2026-11-09 | §6-2 ~ §6-4 | 완료. 스왑 2GB, iptables 저장, 외부에서 `http://<공인IP>` 200 응답 확인, Docker + Compose v5.7.0 |
| 다음 | CI 이미지 빌드 → §7 DNS → §8 HTTPS → §8-1 배포 | |

### 고정 원칙
- **이미지는 CI(GitHub Actions)에서 빌드해 GHCR에 올리고, 서버는 pull만 한다.** 나중에 A1(6GB 이상)으로 옮겨도 서버에서 빌드하지 않는다. 배포가 서버 사양과 상태에 영향받지 않고, 같은 이미지를 로컬·서버에서 재현할 수 있다.

## 0. 이 가이드의 가정과 불확실한 부분 (먼저 읽기)

| 항목 | 확실도 | 비고 |
|---|---|---|
| 홈 리전은 가입 후 변경 불가, Always Free는 홈 리전에서만 생성 가능 | 확실 | 가입이 곧 리전 선택이다 |
| AMD Micro(VM.Standard.E2.1.Micro) 2대 무료 | 확실 | 콘솔에 "Always Free-eligible" 표시가 붙는다 |
| 아웃바운드 전송 월 10TB 무료 | 높음 | 공식 무료 티어 페이지 기준 |
| **무료 계정의 유휴 Always Free 인스턴스는 회수될 수 있음** | 중간 | 7일간 CPU·네트워크 사용률이 낮으면 회수된다고 알려져 있다. 가입 후 공식 문서로 확인한다 (§9) |
| 인스턴스를 중지·시작해도 공인 IP 유지, 삭제 후 재생성하면 변경 | 중간 | 바뀌면 가비아 A 레코드를 갱신한다 |
| ARM(A1) 인스턴스는 용량 부족으로 생성 실패가 잦음 | 확인됨 | 2026-11-09 도쿄에서 실패. 도쿄는 가용성 도메인이 AD-1 하나뿐이라 다른 AD로 우회할 수 없다. 이 프로젝트는 AMD Micro로도 동작하게 설계했다 |
| 무료 계정은 A1 할당 우선순위가 낮고, Pay As You Go로 전환하면 잘 잡힘 | 중간 (추정) | 커뮤니티 후기 기준. 전환 시 §3-1 예산 알림 필수 |

## 1. 준비물

- [ ] **해외 결제가 되는 신용카드**: 본인 확인용이다. Always Free 범위 안에서는 청구되지 않는다. 체크카드는 거절되는 경우가 많다.
- [ ] 휴대폰 (SMS 인증)
- [ ] 가비아 계정 (`galle.cloud` 관리용)
- [ ] 이 PC의 SSH 키 (§4에서 생성)

## 2. 갈래말래 AWS 정리

`galle.cloud`가 지금 AWS 서울 리전 IP(`13.124.141.164`)를 가리키고 있다. AWS 프리티어가 만료된 상태라면 **매달 요금이 나가고 있을 가능성이 높다.**

> 순서: 필요한 데이터 백업 → Oracle 서버 준비 → DNS 전환(§7) → AWS 리소스 삭제. 서버를 먼저 내려도 문제는 없지만, 백업은 반드시 먼저 한다.

AWS 콘솔에서 **서울 리전(ap-northeast-2)**을 선택하고 다음을 확인·삭제한다.

- [ ] **EC2 인스턴스** → 종료(Terminate)
- [ ] **탄력적 IP(Elastic IP)** → 연결 해제 후 **릴리스**. ⚠️ 인스턴스를 지워도 IP는 남아서 계속 과금된다.
- [ ] **EBS 볼륨·스냅샷** → 남은 것 삭제
- [ ] **RDS** → 사용했다면 스냅샷이 필요한지 판단한 뒤 삭제
- [ ] **NAT Gateway / Load Balancer** → 사용했다면 삭제 (이 둘이 가장 비싸다)
- [ ] **S3** → 필요 없으면 버킷 비우고 삭제
- [ ] **Route 53 호스팅 영역** → 사용했다면 삭제 (DNS는 가비아에서 관리 중)
- [ ] **Billing → Bills**에서 이번 달 요금 확인. 다른 리전에도 리소스가 남아 있는지 확인한다.

✅ 확인: 다음 달 예상 요금이 $0으로 표시된다.

## 3. Oracle Cloud 가입

1. https://www.oracle.com/cloud/free/ → **Start for free**
2. 입력 시 주의할 점
   - 이름과 주소는 **영문**으로, **카드 명의와 동일하게** 입력한다.
   - **Home Region: `South Korea North (Chuncheon)`** 선택. ← 이 단계에서만 정할 수 있다.
     - 선택 목록에 없거나 가입이 거절되면 `South Korea Central (Seoul)` → `Japan East (Tokyo)` / `Japan Central (Osaka)` 순으로 시도한다.
     - **미국 리전은 고르지 않는다.** 한국에서 지연이 150ms 이상 늘어난다.
3. 카드 인증: 소액 승인 후 자동 취소된다.

### 가입 실패 시 점검 (예전에 실패했던 원인 후보)
| 증상 | 대응 |
|---|---|
| 카드 거절 / "transaction error" | 해외결제가 되는 신용카드로 바꾼다. 카드사 앱에서 해외결제 차단 설정을 확인한다 |
| 알 수 없는 오류 | VPN·광고 차단 확장 프로그램을 끄고, 일반(비시크릿) 창에서 Chrome으로 다시 시도한다 |
| 같은 카드·이메일로 이전 가입 이력 | 이전 계정이 남아 있을 수 있다. 비밀번호 찾기로 기존 계정을 먼저 확인한다 |
| 여러 번 연속 실패 | 짧은 간격으로 반복하면 차단될 수 있다. 몇 시간 간격을 두고, 그래도 안 되면 Oracle 지원 채팅을 이용한다 |

✅ 확인: OCI 콘솔에 로그인되고, 오른쪽 위 리전이 춘천(또는 선택한 리전)으로 표시된다.

### 3-1. 예산 알림 (가입 직후 바로)
**Billing & Cost Management → Budgets → Create Budget**
- 대상: 루트 compartment, 월 예산 **$1**, 알림 임계값 **1%**, 수신 이메일 입력

과금 대상 리소스가 실수로 생기면 바로 알 수 있다.

## 4. SSH 키 생성 (Windows PowerShell)

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_live -C "oracle-live"
Get-Content $HOME\.ssh\oracle_live.pub   # 이 내용을 §5에서 붙여넣는다
```

- 개인키(`oracle_live`)는 **절대 저장소나 메신저에 올리지 않는다.**

## 5. 네트워크와 인스턴스 생성

> 콘솔은 2026-11 기준 새 UI다. 리소스 상세 화면의 하위 메뉴가 왼쪽 목록이 아니라 **페이지 상단 탭**(세부정보 · 서브넷 · 보안 · 게이트웨이 …)으로 바뀌었다. 탭이 안 보이면 창을 넓힌다.

### 5-1. VCN (가상 네트워크)
**네트워킹 → 가상 클라우드 네트워크 → VCN 마법사 시작 → "인터넷 접속을 통한 VCN 생성"** (Create VCN with Internet Connectivity)
- 이름: `live-vcn`, CIDR은 기본값(`10.0.0.0/16`, 퍼블릭 `10.0.0.0/24`, 프라이빗 `10.0.1.0/24`)
- "인터넷 접속과 사이트 간 VPN…" 옵션은 고르지 않는다. 사내망 연결용이라 DRG 등 불필요한 리소스가 생긴다.
- ⚠️ 마법사 없이 "VCN 생성"으로 직접 만들면 **서브넷과 인터넷 게이트웨이가 없다.** 인스턴스에 공인 IP가 있어도 인터넷에 연결되지 않는다. 이미 그렇게 만들었다면 지우고 마법사로 다시 만든다.

### 5-2. 방화벽 (Security List)
`live-vcn` → **보안** 탭 → **보안 목록**에서 퍼블릭 서브넷에 연결된 목록(`Default Security List for live-vcn`) → **보안 규칙** 탭 → **수신 규칙 추가**
- 마법사는 퍼블릭·프라이빗 서브넷에 서로 다른 보안 목록을 붙인다. 헷갈리면 퍼블릭 서브넷 상세에서 연결된 목록 이름을 확인한다.
- **소스 포트 범위는 비운다**(= 전체). 소스 포트는 클라이언트가 무작위로 고르는 번호다. **대상 포트**에 서버 포트를 적는다.
- 규칙 추가 창의 "+ 다른 수신 규칙"으로 아래 5개를 한 번에 넣을 수 있다.

| 소스 CIDR | 프로토콜 | 포트 | 용도 |
|---|---|---|---|
| 0.0.0.0/0 | TCP | 80 | HTTP (인증서 발급, HTTPS 리다이렉트) |
| 0.0.0.0/0 | TCP | 443 | HTTPS |
| 0.0.0.0/0 | UDP | 443 | HTTP/3 (선택) |
| 0.0.0.0/0 | UDP | 8189 | WebRTC 미디어 |
| 0.0.0.0/0 | TCP | 8189 | WebRTC 미디어 (UDP가 막힌 네트워크용 폴백) |

- SSH(22)는 기본으로 열려 있다. OCI 이미지는 **키 인증만 허용**하므로 그대로 둬도 된다.
- 9997(MediaMTX Control API)과 8889(WHIP/WHEP)는 열지 않는다. Caddy와 api가 Docker 내부 네트워크로만 접근한다.

### 5-3. 인스턴스
**Compute → Instances → Create Instance**

| 항목 | 값 |
|---|---|
| 이름 | `live-server` |
| Image | **Canonical Ubuntu 24.04** |
| Shape | 1순위: **Ampere** 탭 → **VM.Standard.A1.Flex** 시도 → 용량 부족이면 **AMD** 탭 → **VM.Standard.E2.1.Micro** |
| 보안 | 실드된 인스턴스·기밀 컴퓨팅 **끔** |
| Networking | VNIC 이름은 비워도 된다. `live-vcn`의 **퍼블릭 서브넷**, 프라이빗 IP 자동, **공용 IPv4 주소 자동 할당** 체크 |
| SSH keys | **공개 키 붙여넣기** → §4에서 출력한 공개키 붙여넣기 |
| Boot volume | **사용자정의 크기 100GB**, VPU는 기본값 10 (올리면 과금). 녹화가 시간당 약 1.1GB라 기본 47GB는 부족하다. 무료 한도는 전체 200GB |

- Shape 옆에 **"상시 무료 적격"** 표시가 있는지 반드시 확인한다. 이 표시가 없으면 과금된다. 같은 목록의 `VM.Standard.E2.1`(8GB)은 이름이 비슷하지만 **유료**다. `.Micro`로 끝나야 한다.
- A1은 콘솔에서 1 OCPU / 6GB만 선택될 수 있다. 만든 뒤 **작업 → 셰이프 편집**으로 늘릴 수 있다(무료 합계 4 OCPU / 24GB).
- 용량 부족 오류("가용성 도메인 AD-1 셰이프에 대한 용량이 부족합니다")가 뜨면 Micro로 먼저 만들고, A1은 한국 시간 새벽 등에 다시 시도한다. Micro와 A1은 무료 한도가 따로다.
- 이미지는 CI에서 amd64와 arm64를 모두 빌드하므로 어느 셰이프든 상관없다.

✅ 확인: 인스턴스 상태가 **실행 중**이고, **공용 IP 주소**가 표시된다. 이 IP를 메모해 둔다.

## 6. 서버 초기 설정

### 6-1. 접속
```powershell
ssh -i $HOME\.ssh\oracle_live ubuntu@<공인IP>
```

편하게 접속하려면 `$HOME\.ssh\config`에 다음을 추가한다.
```
Host live
  HostName <공인IP>
  User ubuntu
  IdentityFile ~/.ssh/oracle_live
```
그러면 `ssh live`만으로 접속된다.

처음 접속할 때 `Are you sure you want to continue connecting?`가 나오면 `yes`를 입력한다.

### 6-1-1. 셰이프 확인
```bash
uname -m; free -h; df -h /; lsb_release -d
```
E2.1.Micro 기준 기대값 (2026-11-09 실제 결과):

| 항목 | 값 |
|---|---|
| 아키텍처 | `x86_64` (A1이면 `aarch64`) |
| 메모리 | total `952Mi`, Swap `0B` ← 6-2에서 만든다 |
| 디스크 | `/` 약 `96G` (부트 볼륨 100GB가 첫 부팅 때 자동 확장됨) |
| OS | Ubuntu 24.04.x LTS |

- 프롬프트의 호스트명은 VNIC 이름(`live-server-vnic`)으로 잡힐 수 있다. 동작에는 영향이 없다.
- 메모리가 8GB로 나오면 유료 `VM.Standard.E2.1`로 만든 것이다. 즉시 종료하고 `.Micro`로 다시 만든다.

### 6-2. 기본 패키지·시간대·스왑
```bash
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Asia/Seoul

# 메모리 1GB(Micro)에서는 스왑이 필수다. 이미지 pull·압축 해제와 컨테이너 기동이 겹치면 1GB를 넘는다.
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 스왑은 비상용으로만 쓰도록 한다 (기본 60 → 10)
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl --system > /dev/null
free -h
```
- Micro는 CPU가 1/8 코어라 `apt upgrade`에 10분 이상 걸릴 수 있다. 멈춘 것이 아니다.
- 업그레이드 중 "Which services should be restarted?" 같은 보라색 화면(needrestart)이 나오면 기본 선택 그대로 엔터를 누른다.
- 커널이 업데이트됐다면(`/var/run/reboot-required` 파일이 있으면) `sudo reboot` 후 재접속한다.
- A1(6GB 이상)으로 옮기면 스왑은 생략해도 된다.

### 6-3. ⚠️ OS 방화벽 (OCI Ubuntu 이미지 함정)
OCI의 Ubuntu 이미지는 **iptables가 22번 외 모든 포트를 막아둔 상태**로 시작한다. Security List만 열면 외부에서 접속되지 않는다. 가장 흔하게 막히는 지점이다.

```bash
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443,8189 -j ACCEPT
sudo iptables -I INPUT -p udp -m multiport --dports 443,8189 -j ACCEPT
sudo netfilter-persistent save
sudo iptables -L INPUT -n --line-numbers | head -10   # ACCEPT 규칙이 REJECT보다 위에 있어야 한다
```
- `netfilter-persistent: command not found`가 나오면 `sudo apt install -y iptables-persistent`로 설치한 뒤 다시 `save`한다.
- 재부팅 후에도 규칙이 남아 있는지 `sudo reboot` → 재접속 → `iptables -L INPUT -n`으로 한 번 확인한다.

#### 외부에서 포트가 열렸는지 확인
포트를 열어도 **그 포트를 듣는 프로그램이 없으면** 외부에서는 연결 거부로 보인다. 임시 웹서버로 확인한다.
```bash
sudo python3 -m http.server 80   # Ctrl+C로 종료
```
PC 브라우저에서 `http://<공인IP>`(https 아님)로 접속한다.
- 파일 목록이 보이면 Security List와 iptables가 모두 정상이다.
- 시간 초과가 나면 §5-2(Security List) 또는 위 iptables 중 하나가 막혀 있다. `iptables -L INPUT -n --line-numbers`에서 ACCEPT가 REJECT보다 위에 있는지 본다.

### 6-4. Docker 설치
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu

# 컨테이너 로그가 디스크를 채우지 않도록 크기를 제한한다
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
exit   # 다시 접속해야 docker 그룹이 적용된다
```
재접속한 뒤 확인한다.
```bash
docker run --rm hello-world
docker compose version
free -h
```

✅ 확인: `hello-world`가 출력되고, `free -h`에 Swap 2.0Gi가 표시된다.

### 6-5. Micro(1GB) 운영 원칙
- **서버에서 이미지를 빌드하지 않는다.** `docker compose`는 항상 `pull` 후 `up -d --no-build`로 실행한다(§8-1). 서버에서 `npm ci`나 웹 빌드를 돌리면 메모리가 부족해 멈출 수 있다.
- api는 Dockerfile에서 Node 힙을 192MB로 제한해 두었다. 메모리 사용량은 `docker stats --no-stream`과 `free -h`로 확인한다.
- 스왑 사용량이 계속 수백 MB 이상이면 A1 이전을 다시 시도할 때다(§5-3).

## 7. DNS 전환 (가비아)

**My가비아 → DNS 관리툴 → `galle.cloud` → DNS 설정**

기존에 AWS IP(`13.124.141.164`)를 가리키던 레코드의 **값을 Oracle 공인 IP로 바꾼다.**

| 타입 | 호스트 | 값 | TTL |
|---|---|---|---|
| A | `@` | Oracle 공인 IP | 600 |
| A | `www` | Oracle 공인 IP | 600 |

- 같은 호스트에 A 레코드가 2개 이상 남아 있으면 안 된다. 예전 값은 삭제한다.
- 갈래말래용 레코드(예: `api` 등)가 더 있다면 함께 정리한다.

PC에서 전파되었는지 확인한다.
```powershell
nslookup galle.cloud 8.8.8.8
nslookup www.galle.cloud 8.8.8.8
```

✅ 확인: 두 주소 모두 Oracle 공인 IP로 조회된다. **이걸 확인하기 전에는 §8을 진행하지 않는다.** DNS가 덜 바뀐 상태에서 인증서 발급을 반복하면 Let's Encrypt 발급 제한에 걸린다.

## 8. HTTPS 연결 테스트 (앱 배포 전 연기 테스트)

```bash
mkdir -p ~/smoke && cd ~/smoke
cat > Caddyfile <<'EOF'
galle.cloud {
	respond "hello from oracle" 200
}
www.galle.cloud {
	redir https://galle.cloud{uri} permanent
}
EOF
docker run -d --name smoke -p 80:80 -p 443:443 \
  -v $PWD/Caddyfile:/etc/caddy/Caddyfile -v smoke_data:/data caddy:2
docker logs -f smoke   # "certificate obtained successfully"가 나오면 Ctrl+C
```

PC 브라우저와 휴대폰(**Wi-Fi를 끄고 모바일 데이터로**)에서 `https://galle.cloud`에 접속한다.

✅ 확인: 자물쇠 아이콘과 함께 `hello from oracle`이 표시된다. `www.galle.cloud`는 루트로 리다이렉트된다.

테스트가 끝나면 정리한다.
```bash
docker rm -f smoke && docker volume rm smoke_data
```

> WebRTC 포트(8189)는 MediaMTX를 올리는 스파이크(#2)에서 검증한다.
> OCI VM은 NAT 뒤에 있어서 자기 공인 IP를 모른다. 그래서 MediaMTX 설정에 `webrtcAdditionalHosts: [galle.cloud]`를 반드시 넣어야 한다. 이 설정이 없으면 **시그널링은 성공하는데 영상이 안 나오는** 증상이 생긴다.

## 8-1. 앱 배포 (CI 이미지 pull)

이미지는 `main`에 push하면 `.github/workflows/images.yml`이 amd64·arm64로 빌드해 GHCR에 올린다.
- `ghcr.io/sanggeun-cho/live-streaming-platform/caddy:latest` (+ `sha-<커밋>` 태그)
- `ghcr.io/sanggeun-cho/live-streaming-platform/api:latest` (+ `sha-<커밋>` 태그)

첫 실행 후 GitHub → 프로필 → **Packages**에서 두 패키지가 **Public**인지 확인한다. Private이면 서버에서 `docker login ghcr.io`가 필요하다.

서버에는 compose 파일, MediaMTX 설정, `.env`만 있으면 된다. 저장소를 받아 그 파일들을 쓴다.
```bash
git clone -b main https://github.com/Sanggeun-Cho/live-streaming-platform.git ~/live
cd ~/live
cp .env.example .env && nano .env   # SITE_ADDRESS=galle.cloud, WWW_ADDRESS=www.galle.cloud, MEDIA_PUBLIC_HOST=galle.cloud, INTERNAL_SECRET
docker compose pull
docker compose up -d --no-build
docker compose ps
```

업데이트할 때:
```bash
cd ~/live && git pull && docker compose pull && docker compose up -d --no-build
docker image prune -f
```
롤백할 때는 `.env`에 `IMAGE_TAG=sha-<이전 커밋>`을 넣고 `pull` → `up -d --no-build`를 다시 실행한다.

- `--no-build`를 빼먹으면 이미지가 없을 때 서버에서 빌드를 시도한다. 1GB VM에서는 멈출 수 있으니 항상 붙인다.

## 9. 운영 체크리스트

- [ ] **유휴 회수 대응**: 공식 문서에서 "Always Free idle compute instances reclaim" 정책을 확인한다. 제출 직전(11-18)에 다음 중 하나를 결정한다.
  - **Pay As You Go 전환**: Always Free 범위는 계속 0원이고 회수 대상에서 빠진다. 대신 §3-1의 $1 예산 알림이 **필수**다.
  - **전환하지 않음**: 심사 기간 동안 주 2회 이상 접속해 상태를 확인한다.
- [ ] **SQLite 백업**: 매일 cron으로 DB 파일을 복사해 7일치를 보관한다 (#9에서 구성).
- [ ] **시크릿**: `.env`는 서버에만 둔다. 저장소에는 `.env.example`만 올린다.
- [ ] **디스크**: 녹화는 1시간에 약 1.1GB를 쓴다. `df -h`로 주기적으로 확인한다.

## 10. 문제 해결

| 증상 | 원인 후보 | 확인·조치 |
|---|---|---|
| 브라우저에서 접속 시간 초과 | Security List 또는 iptables | §5-2와 §6-3을 다시 확인한다. 서버 안에서 `curl -I localhost`가 되는지 본다 |
| 인증서 발급 실패 | DNS 미전파, 80 포트 막힘 | `nslookup`으로 IP를 확인하고, 80 포트가 열려 있는지 본다. 반복 시도하지 말고 원인부터 찾는다 |
| SSH 접속 거부 | 키 경로나 사용자 이름 | 사용자 이름은 `ubuntu`. `-i` 옵션의 키 경로를 확인한다 |
| A1 "Out of capacity" | 리전 용량 부족 | E2.1.Micro로 만든다. A1은 나중에 다시 시도한다 |
| 영상이 연결되지 않음 (시그널링은 성공) | NAT 뒤 공인 IP 미설정, 8189 막힘 | `webrtcAdditionalHosts` 설정, 8189 UDP/TCP의 Security List와 iptables를 확인한다 |
| 휴대폰에서만 연결 안 됨 | 이동통신망 UDP 제한 | 8189/TCP 폴백이 열려 있는지 확인한다 |
