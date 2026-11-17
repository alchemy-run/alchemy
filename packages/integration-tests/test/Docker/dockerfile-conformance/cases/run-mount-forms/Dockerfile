FROM alpine
RUN --mount=type=cache,target=/c,id=npm,sharing=locked,mode=0755,uid=1000,gid=1000 --mount=type=tmpfs,target=/t,size=64m --mount=type=secret,id=tok,required --mount=type=ssh,required=true --mount=type=bind,source=.,target=/src,rw --mount=type=bind,from=build,src=/out,dst=/o,ro=true true
