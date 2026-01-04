FROM golang:1.22-alpine AS builder
WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/ctopweb ./main.go

FROM alpine:3.20
RUN addgroup -S app && adduser -S app -G app
RUN apk add --no-cache ca-certificates
COPY --from=builder /bin/ctopweb /usr/local/bin/ctopweb

ENV PORT=4000
ENV DOCKER_SOCKET=/var/run/docker.sock
EXPOSE 4000

USER app
CMD ["ctopweb"]
