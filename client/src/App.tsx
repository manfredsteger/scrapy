import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import SinglePageDetail from "@/pages/SinglePageDetail";
import Converter from "@/pages/Converter";
import NotFound from "@/pages/not-found";
import { AuthGate } from "@/components/AuthGate";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/converter" component={Converter} />
      <Route path="/single-page/:id" component={SinglePageDetail} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthGate>
          <Router />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
